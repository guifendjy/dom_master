const braceRegex = new RegExp(/\{\s*([^\{\}]+?)\s*\}/, "g");

const start_each = new RegExp(
  /\{for:each (\{[^}]*\}|[^\{,]+)(?:, ([^,]+))? of ([^\}]+)\}/
);
const endEach = new RegExp(/\{end:each\}/);

const start_if = new RegExp(/\{start\:if (.*?)\}/);
const elseRegx = new RegExp(/\{\:else\}/);
const endIfRegx = new RegExp(/\{end\:if\}/);

class ReactiveState {
  constructor(initialState = {}) {
    this.state = initialState; // Internal state object
    this.subscribers = new Map(); // Tracks which variables have subscribers
    this.expressions = [];

    // Create a proxy for the state
    this.proxy = new Proxy(this.state, {
      get: (target, key) => {
        return key in target ? target[key] : undefined;
      },
      set: (target, key, value) => {
        if (target[key] !== value) {
          // if it's an array changes will have to be significant to trigger a update
          target[key] = value;
          this.#notify(key); // Notify dependent nodes of changes
          this.#checkExpression(key);
        }
        return true;
      },
    });

    // Bind instance methods to ensure they remain accessible
    this.subscribe = this.subscribe.bind(this);
    this.notify = this.#notify.bind(this);

    return new Proxy(this, {
      get: (target, key) => {
        // Ensure state and class methods are both accessible
        if (key in target) {
          return target[key];
        }
        if (key in target.proxy) {
          return target.proxy[key];
        }
        return undefined;
      },
      set: (target, key, value) => {
        if (key in target.proxy) {
          target.proxy[key] = value;
          return true;
        }
        return false;
      },
    });
  }

  // Subscribe a callback to a key
  subscribe(key, callback) {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    if (!this.subscribers.get(key).has(callback))
      this.subscribers.get(key).add(callback);
    return {
      unsubscribe: () => {
        this.subscribers.get(key).delete(callback);
      },
    };
  }

  addExpression(variables, callback) {
    let dependencies = { variables, callback };
    this.expressions.push(dependencies);
    return {
      unsubscribe: () => {
        let index = this.expressions.findIndex((obj) => obj !== dependencies);
        this.expressions.slice(index, 1);
      },
    };
  }

  // Notify all subscribers of a key
  #notify(key) {
    if (this.subscribers.has(key)) {
      for (const callback of this.subscribers.get(key)) {
        callback();
      }
    }
  }
  #checkExpression(changedKey) {
    this.expressions.forEach(({ variables, callback }) => {
      if (variables.includes(changedKey)) {
        callback();
      }
    });
  }
}

// utils
function createLocalProxy(localState, globalState, globalManager) {
  return new Proxy(
    {
      ...localState,
      __globalState: { ...globalState },
      __globalManager: globalManager,
    },
    {
      get(target, key) {
        // console.log("local", key);

        if (key in target) return target[key];
        if (key in globalState) return globalState[key];
      },
      set(target, key, value) {
        if (typeof target[key] == "object" && target[key] == value) return true;

        if (key in target) {
          target[key] = value;

          return true;
        }
        if (key in globalState) {
          globalState[key] = value;
          return true;
        }
        return false;
      },
    }
  );
}

function replaceVariables(template, variables) {
  return template.replace(braceRegex, (_, expression) => {
    const trimmedExpression = expression.trim();
    const evaluation = evaluateExpression(trimmedExpression, variables);
    return evaluation;
  });
}

function evaluateExpression(expression, stateProxy) {
  // console.log(expression, stateProxy);
  const keys = Object.keys(stateProxy);
  const values = Object.values(stateProxy);

  try {
    const fn = new Function(...keys, `return (${expression});`);
    const evaluation = fn(...values);

    return evaluation;
  } catch (error) {
    try {
      const globalStateProxy = stateProxy.__globalManager.proxy;

      if (globalStateProxy) {
        let fn = new Function(
          ...Object.keys(globalStateProxy),
          `return (${expression});`
        );
        return fn(...Object.values(globalStateProxy));
      }
    } catch (fallbackError) {
      // console.log(expression, stateProxy);
      console.error(`Error evaluating expression ${expression}`);
      return null;
    }
  }
}

function setAttributes(element, attrName, value) {
  if (value === "true") {
    // Boolean attributes: set the attribute with an empty value
    element.setAttribute(attrName, "");
  } else if (value === "false" || value === "null" || value === "undefined") {
    // Boolean attributes: remove the attribute
    element.removeAttribute(attrName);
  } else if (attrName === "value" && element instanceof HTMLInputElement) {
    // Special case for input value: set the property directly
    // element.setAttribute("value", value); // this reflects the state in the dom -> it less performant
    element.value = value;
  } else if (attrName === "style" && typeof value === "string") {
    // Style attribute: set as a string
    element.setAttribute("style", value);
  } else if (attrName === "class") {
    // Class attribute: set as a string
    element.setAttribute("class", value);
  } else {
    // General case: set the attribute directly
    element.setAttribute(attrName, value);
  }
}

let Booleans = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "NaN",
  "Infinity",
  "-Infinity",
];
const isStringRegx = new RegExp(/(['"])(?:(?!\1|\\).|\\.)*\1/); // check for string args -> "hello" : it's not a prop in variables

// textNodes and attributes parse
function parseNode(node, variables, stateManager) {
  if (node.nodeType === Node.TEXT_NODE) {
    const template = node.nodeValue;
    if (!braceRegex.test(template)) return;

    const update = () => {
      node.nodeValue = replaceVariables(template, variables);
    };
    update();

    registerDependencies(template, variables, update, stateManager);
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    // Process attributes
    Array.from(node.attributes).forEach((attr) => {
      if (attr.name.startsWith("on")) {
        // Event handling
        const eventType = attr.name.slice(2);
        const functionInvocation = attr.value.trim();
        const match = functionInvocation.match(
          /\s*(\w+)\s*(?:\(\s*(.*?)\s*\))?\s*/
        );

        if (!match)
          return console.error(
            `Invalid event handler syntax in attribute ${attr.name}:"${functionInvocation}". Expected ${attr.name}:"functionName" or "functionName(arg1, arg2,...)."`
          );

        const functionName = match[1].trim();
        const argString = match[2] ? match[2].trim() : null;

        const handler = variables[functionName];

        if (!handler)
          return console.warn(`function ${functionName} is not defined.`);

        if (typeof handler === "function") {
          node.addEventListener(eventType, (e) => {
            const argv = argString
              ? argString
                  .split(/\s*,\s*/)
                  .map((arg) => getArgumentValue(arg.trim(), variables))
              : [];

            handler.call(variables, ...argv, e);
          });
        }
        node.removeAttribute(attr.name);
      } else {
        // Reactive attributes
        const template = attr.nodeValue;
        if (!braceRegex.test(template)) return;

        const update = () => {
          const value = replaceVariables(template, variables);

          setAttributes(node, attr.name, value);
        };
        update();
        registerDependencies(template, variables, update, stateManager);
      }
    });

    // Process child nodes
    Array.from(node.childNodes).forEach((child) =>
      parseNode(child, variables, stateManager)
    );
  }
}

function getArgumentValue(currentArg, variables) {
  // handles boolean
  if (Booleans.some((b) => b == currentArg)) {
    return parsePrimitive(currentArg);
  }

  // handles strings
  if (isStringRegx.test(currentArg)) {
    let match = currentArg.match(isStringRegx);
    return match[0].trim().replace(/['"]/g, ""); // removes quotes
  } else {
    // handles state derived data

    if (currentArg.includes(".")) {
      let objKey = currentArg.split(".")[0];
      let targetKey = currentArg.split(".").at(-1);

      if (!(targetKey in variables[objKey])) {
        console.error(
          `Error: undefined reading arguments ${currentArg}.`,
          variables[objKey]
        );
        return;
      }
    }

    return evaluateExpression(currentArg, variables); // else evaluate it from state
  }
}

// parses if Statements
function getBlock(nodes) {
  let i = 0;

  while (i < nodes.length) {
    if (
      nodes[i].nodeType === Node.TEXT_NODE &&
      start_if.test(nodes[i].nodeValue)
    ) {
      let j = i + 1;
      let elseIndex = -1;
      let blockStart = nodes[i];
      let condition = nodes[i].nodeValue.match(start_if)[1];

      // Scan for "end" or "else"
      while (j < nodes.length) {
        if (
          nodes[j].nodeType === Node.TEXT_NODE &&
          endIfRegx.test(nodes[j].nodeValue)
        ) {
          break; // End of block
        }
        if (
          nodes[j].nodeType === Node.TEXT_NODE &&
          elseRegx.test(nodes[j].nodeValue) &&
          elseIndex === -1
        ) {
          elseIndex = j; // Mark first occurrence of "else"
        }

        j++;
      }

      // Extract the if block
      let ifBlock = nodes.slice(i + 1, elseIndex !== -1 ? elseIndex : j);
      let elseBlock = elseIndex !== -1 ? nodes.slice(elseIndex + 1, j) : [];

      nodes.splice(i, j - i);
      // Remove processed nodes
      return { ifBlock, elseBlock, blockStart, condition };
    }
    i++;
  }

  return null;
}

// new implementation -> may have fixed the consecutive blocks issues
function parseIfStatements(node, variables, stateManager) {
  const nodes = Array.from(node.childNodes);
  if (!nodes.length) return;
  let shallowCopyOfNodes = [...nodes]; // temp copy of nodes
  let blocks = [];

  // Extract blocks at the same level
  while (shallowCopyOfNodes.length) {
    let currentBlock = getBlock(shallowCopyOfNodes);
    if (!currentBlock) break;
    blocks.push(currentBlock);
  }

  // Process extracted blocks
  blocks &&
    blocks.forEach(
      ({
        ifBlock: ifNodes,
        elseBlock: elseNodes,
        condition: expression,
        blockStart,
      }) => {
        const parentNode = node;

        // console.log(ifNodes, elseNodes, expression);

        // their initial node parsing to save reactive bits for update
        ifNodes.forEach((node) => {
          parseEachBlocks(node, variables, stateManager);
          parseIfStatements(node, variables, stateManager); // handles nested if statements
          parseNode(node, variables, stateManager);
        });
        elseNodes.length &&
          elseNodes.forEach((node) => {
            parseEachBlocks(node, variables, stateManager);
            parseIfStatements(node, variables, stateManager);
            parseNode(node, variables, stateManager);
          });

        let lastEval = undefined;
        let tempFragment = document.createDocumentFragment(); // temporarily holds the nodes

        // Initial rendering
        const update = () => {
          let evaluation = evaluateExpression(expression, variables);
          if (lastEval === evaluation) return;

          if (evaluation) {
            ifNodes.forEach((n) => tempFragment.appendChild(n));
            elseNodes.length && elseNodes.forEach((n) => n.remove());
          } else {
            elseNodes.length &&
              elseNodes.forEach((n) => tempFragment.appendChild(n));
            ifNodes.forEach((n) => n.remove());
          }
          parentNode.insertBefore(tempFragment, blockStart.nextSibling);
          lastEval = evaluation;
        };

        update();
        registerDependencies(
          `{${expression}}`,
          variables,
          update,
          stateManager
        );
      }
    );

  // Cleanup syntax markers
  nodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      n.nodeValue = n.nodeValue
        .replace(start_if, "")
        .replace(elseRegx, "")
        .replace(endIfRegx, "");
    }
  });

  // Continue parsing the remaining nodes (non-if blocks)
  nodes.forEach((child) => parseIfStatements(child, variables, stateManager));
}

// parses each blocks
function parseEachBlocks(element, variables, stateManager) {
  const nodes = Array.from(element.childNodes);
  if (!nodes.length) return;

  nodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE && start_each.test(node.nodeValue)) {
      const match = node.nodeValue.match(start_each);

      let itemName = match[1].trim();
      const indexName = match[2]?.trim() || "index";
      const arrayName = match[3].trim();

      // allows object destrucutring in for each for itemName
      const isDistructuredItem = braceRegex.test(itemName);
      const keys =
        isDistructuredItem && itemName.split(/[^a-zA-Z_$\.]+/).filter(Boolean);
      isDistructuredItem && (itemName = "__domMasterObject__"); // won't be used when updating dynamicly created elements. need key values paird will be spread in the localProxy created.

      const eachContent = node.nextElementSibling;

      const expression = node.nodeValue.trim();

      if (!endEach.test(eachContent.nextSibling.nodeValue)) {
        console.error(
          `Error: Expected closing state for each block: ${expression}`
        );
      }

      const parentNode = node.parentNode;
      let blockStart = node;

      // Create a tracking state for the block
      const state = {
        domNodes: [], // Tracks rendered DOM nodes
      };

      const update = () => {
        // Handle additions, removals, or reordering
        // const newItems = variables[arrayName];
        let value = getValueFromExpression(variables, arrayName).value || [];
        const newItems = value ? value : null;

        // gotta handle each expression for nested for each
        if (!newItems || !Array.isArray(newItems)) {
          // throw new Error(`${arrayName}: is not an array at ${expression}`);
          console.error(
            `${arrayName}: is not an array at ${expression}`,
            variables
          );
        }

        // will use an object to
        newItems.forEach((item) => {
          if (typeof item === "object" && !item._dom_master_key) {
            Object.defineProperty(item, "_dom_master_key", {
              value: uniid(),
              enumerable: false,
              writable: false,
            });
          }
        });

        // set oldNodes
        const oldNodeMap = new Map(
          state.domNodes.map(({ node, data, stateProxy, localManager }) => {
            return [
              data._dom_master_key,
              { node, data, stateProxy, localManager },
            ];
          })
        );

        const newDomNodes = [];

        newItems.forEach((item, index) => {
          const _dom_master_key =
            typeof item === "object" ? item._dom_master_key : item;

          if (oldNodeMap.size && oldNodeMap.has(_dom_master_key)) {
            const { node, data, stateProxy, localManager } =
              oldNodeMap.get(_dom_master_key);

            if (data.index != index) {
              // update index binding for node(via proxy)
              stateProxy[indexName] = index;
              localManager[indexName] = index;
            }

            let newData =
              typeof data.item == "object" ? structuredClone(item) : item;

            // FIXME: here accessing the proxy (when updating existing nodes) is neccessary for subscrition to trigger(need investigating)
            if (keys) {
              keys.forEach((key) => {
                stateProxy[key] = newData[key];
                localManager.proxy[key] = newData[key];
              });
            } else {
              stateProxy[itemName] = newData;
              localManager.proxy[itemName] = newData;
            }

            // save new data
            newDomNodes.push({
              node,
              data: {
                item,
                index: index,
                _dom_master_key,
              },
              stateProxy,
              localManager,
            });

            oldNodeMap.delete(_dom_master_key);
          } else if (newItems.length !== state.domNodes.length) {
            let localContext = {};
            if (isDistructuredItem) {
              const newObj = Object.fromEntries(
                keys.map((key) => {
                  if (!(key in item))
                    console.error(
                      `Error: undefined reading ${key} at: ${expression}`
                    );
                  return [key, item[key]];
                })
              );

              localContext = {
                ...newObj,
                [indexName]: index,
              };
            } else {
              localContext = {
                [itemName]: item,
                [indexName]: index,
              };
            }

            const localManager = new ReactiveState(
              localContext,
              // persist store down to dynamicly created elements
              stateManager?.globalState
            );
            const localProxy = localManager.proxy;

            const stateProxy = createLocalProxy(
              localProxy,
              variables,
              stateManager
            );

            const node = eachContent.cloneNode(true); // cloned node

            // handles nested blocks
            // parseEachBlocks(node, stateProxy, localManager);
            if (
              Array.from(node.childNodes).some((n) =>
                start_each.test(n.nodeValue)
              )
            ) {
              console.warn(
                "for:each -> does not work well with nested statements for too much change might cause interfaces to behave in unexpected ways. use for simpler tasks!"
              );
            }
            parseEachBlocks(node, stateProxy, localManager);
            parseIfStatements(node, stateProxy, localManager); // allow dynamic nested if blocks
            parseNode(node, stateProxy, localManager);

            newDomNodes.push({
              node,
              data: { item, index, _dom_master_key }, // initializes the key when creating a nodes. and persist it.
              stateProxy,
              localManager,
            });
          }
        });

        // remove oldnodes
        oldNodeMap.forEach(({ node }) => {
          parentNode.removeChild(node);
        });

        // append new domnodes
        let node_placeholder = document.createDocumentFragment();
        newDomNodes.forEach(({ node }) => {
          node_placeholder.appendChild(node);
        });

        if (node_placeholder.childNodes.length) {
          parentNode.insertBefore(node_placeholder, blockStart.nextSibling); // makes sure that it doesn't brake the normal flow of the ui.
        }

        // update state
        state.domNodes = newDomNodes;
      };

      if (eachContent) {
        // intial render
        update();
        // Register for reactive updates
        registerDependencies(`{${arrayName}}`, variables, update, stateManager);
        eachContent.remove();
      } else {
        console.error(`Error: empty for:each block. at ${expression}`);
      }
    }
  });

  // cleanup synthax
  nodes.forEach((node) => {
    if (node.nodeType == Node.TEXT_NODE) {
      node.nodeValue = node.textContent
        .replace(start_each, "")
        .replace(endEach, "");
    }
  });

  nodes.forEach((child) => {
    parseEachBlocks(child, variables, stateManager);
  });
}

function uniid() {
  let random = parseFloat(Math.random() * 0.999999);
  return random.toString(36).substring(2, 12);
}

function getValueFromExpression(variables, target) {
  const parts = target.split(/[.\[\]]/).filter(Boolean);
  let current = variables;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (current == null || !(key in current)) {
      return { has: false, value: undefined };
    }
    current = current[key];
  }
  const laskey = parts[parts.length - 1];
  return { has: true, value: current[laskey] };
}
function registerDependencies(template, variables, callback, stateManager) {
  const expressions = template.match(braceRegex);

  expressions.forEach((expression) => {
    const filteredTokens = getTokensFromExpression(
      expression,
      variables,
      stateManager
    );

    if (filteredTokens.length == 1) {
      filteredTokens.forEach((token) => {
        if (variables?.__globalState && token in variables.__globalState) {
          // takes care of dynamiclly created nodes
          variables.__globalManager.subscribe(token, callback);
        } else {
          stateManager.subscribe(token, callback);
        }
      });
    }
    // saves update for an expression that depends on multiple state properties(if at least one changes update is triggered)
    else {
      if (
        filteredTokens.some(
          (token) =>
            variables?.__globalState && token in variables.__globalState
        )
      ) {
        unsub = variables.__globalManager.addExpression(
          filteredTokens,
          callback
        );
      } else {
        stateManager.addExpression(filteredTokens, callback);
      }
    }
  });
}

function getTokensFromExpression(expression, variables, stateManager) {
  const tokens = expression
    .replace(/(['"])(?:(?!\1|\\).|\\.)*\1/g, "") // Remove quoted substrings
    .trim()
    .split(/[^a-zA-Z_$\.]+/)
    .filter(Boolean);

  function isInTarget(key, target) {
    return key in target;
  }

  // filter tokens(props in state)
  const filteredTokens = [...new Set(tokens)]
    .map((token) => {
      if (token.includes(".")) {
        return token.split(".")[0];
      }
      if (token.includes("[")) {
        return token.split("[")[0];
      }
      return token;
    })
    .filter((token) => {
      let isInVars = isInTarget(token, variables);
      let isIn_globalState =
        variables?.__globalState && isInTarget(token, variables?.__globalState);
      let isInGlobalStore =
        stateManager?.globalState &&
        isInTarget(token, stateManager.globalState.state);

      let check = isInVars || isIn_globalState || isInGlobalStore;
      return check || false;
    });

  return filteredTokens || [];
}

// Main render function
function createElement(template, stateManager) {
  const fragment = document.createRange().createContextualFragment(template);

  const proxy = stateManager.proxy;

  Array.from(fragment.childNodes).forEach((node) => {
    parseEachBlocks(node, proxy, stateManager);
  });
  Array.from(fragment.childNodes).forEach((node) => {
    parseIfStatements(node, proxy, stateManager);
  });
  Array.from(fragment.childNodes).forEach((node) => {
    parseNode(node, proxy, stateManager);
  });

  return fragment;
}
// CDN
(function (g) {
  g.master = {
    createElement,
    ReactiveState,
  };
})(window);

export { createElement, ReactiveState };
