import "./each_prototype.js";
const braceRegex = new RegExp(/\{\s*([^\{\}]+?)\s*\}/, "g");

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
        // console.log(
        //   "reactive prox",
        //   key,
        //   { new: value, old: target[key] },
        //   target[key] === value
        // );
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
//FIXME: text nodes and attributes evaluates expression rather than trigger a getter, so any vars outside the local state
// which is used in an attribute or text node when evaluated it doesn't work, cause eval won't match against local state.
// local proxy(syncronizes gobal state with localState)
export function createLocalProxy(localState, globalState, globalManager) {
  return new Proxy(
    {
      ...localState,
      __globalState: { ...globalState },
      __globalManager: globalManager,
    },
    {
      get(target, key) {
        if (key in target) return target[key];
        if (key in globalState) return globalState[key];
      },
      set(target, key, value) {
        // console.log("local", key, value);
        if (target[key] === value) return;
        if (key in target) {
          target[key] = value;

          return true;
          // will initial update here
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

// Utility functions
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

//FIXME: style and class attributes needs more surgical change

function setAttributes(element, attrName, value) {
  if (value === "true") {
    element[attrName] = value;
  } else if (value === "false" || value == "null") {
    element.removeAttribute(attrName);
  } else {
    if (attrName == "style") {
      element.setAttribute(attrName, value);
    }
    if (attrName == "class") attrName = "className";
    element[attrName] = value;
  }
}

// Main DOM parsing functions
function parseNode(node, variables, stateManager) {
  if (node.nodeType === Node.TEXT_NODE) {
    const template = node.nodeValue;
    if (!braceRegex.test(template)) return;

    const update = () => {
      node.nodeValue = replaceVariables(template, variables);
    };
    update();

    const { unsubscribe } = registerDependencies(
      template,
      variables,
      update,
      stateManager
    );
    observeNode(node.parentNode, unsubscribe);
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
                  .map((arg) => evaluateExpression(arg.trim(), variables))
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
        const { unsubscribe } = registerDependencies(
          template,
          variables,
          update,
          stateManager
        );
        observeNode(node, unsubscribe);
      }
    });

    // Process child nodes
    Array.from(node.childNodes).forEach((child) =>
      parseNode(child, variables, stateManager)
    );
  }
}

// function to observe node and to unsub them when they are no longer on the dom
// temporary it doesn't do a thorough cleanup.
function observeNode(targetElement, unsubCallback) {
  const observer = new MutationObserver(function (mutationList) {
    mutationList.forEach((mutation) => {
      if (mutation.type === "childList") {
        mutation.removedNodes.forEach((removedNode) => {
          if (removedNode.isEqualNode(targetElement)) {
            unsubCallback();
            // console.log(removedNode, unsubCallback);
          }
        });
      }
    });
  });

  let root = document.body;
  if (root) observer.observe(root, { childList: true, subtree: true });
}

// parses if Statements
function parseIfStatements(node, variables, stateManager) {
  const nodes = Array.from(node.childNodes);
  nodes.forEach((node, index) => {
    const start_if = new RegExp(/\{start\:if (.*?)\}/);
    let elseRegx = new RegExp(/\{\:else\}/);
    let endIfRegx = new RegExp(/\{end\:if\}/);

    if (node.nodeType === Node.TEXT_NODE && start_if.test(node.nodeValue)) {
      let condition = node.nodeValue.match(start_if);

      if (condition) {
        const expression = condition[1];

        const shallowCopyOfNodes = [...nodes]; // temp copy of nodes
        const nodeChildren = shallowCopyOfNodes.slice(index);

        // getting block nodes
        const ifBlockNodes = getNodeRange(
          shallowCopyOfNodes.slice(index + 1),
          (node) =>
            elseRegx.test(node.nodeValue) || endIfRegx.test(node.nodeValue)
        );
        const elseIndexStart = nodes.findIndex((node) =>
          elseRegx.test(node.nodeValue)
        );

        const elseBlockNodes =
          elseIndexStart != -1
            ? getNodeRange(nodes.slice(elseIndexStart + 1), (node) =>
                endIfRegx.test(node.nodeValue)
              )
            : [];

        const parentNode = node.parentNode;
        // will use to remove and replace
        const [start, end] = nodeChildren
          .filter(
            (node) =>
              start_if.test(node.nodeValue) ||
              endIfRegx.test(node.nodeValue) ||
              elseRegx.test(node.nodeValue)
          )
          .map((node) => {
            node.nodeValue = "";
            return node;
          });

        // warning
        if (!expression) {
          return console.error(
            `Error evaluating statement. expected {start:if condition} but got: ${node.nodeValue.trim()}`
          );
        }

        // their initial node parsing to save reactive bits for update
        ifBlockNodes.forEach((node) => {
          parseNode(node, variables, stateManager);
        });
        elseBlockNodes.length &&
          elseBlockNodes.forEach((node) => {
            parseNode(node, variables, stateManager);
          });
        // updater function
        let lastEval = undefined;
        const update = () => {
          let evaluation = evaluateExpression(expression, variables);
          // guards against unnecessary rerenders if condition hasn't changed
          if (lastEval === evaluation) return;

          let current = start.nextSibling;
          while (current && current !== end) {
            const next = current.nextSibling;
            parentNode.removeChild(current);
            current = next;
          }

          const contentToRender = evaluation ? ifBlockNodes : elseBlockNodes;

          contentToRender.forEach((node) => {
            parentNode.insertBefore(node, end);
          });

          lastEval = evaluation;
        };
        update(); // initial render
        registerDependencies(
          `{${expression}}`,
          variables,
          update,
          stateManager
        ); // register for rerender
      }
    }
  });

  nodes.forEach((child) => {
    parseIfStatements(child, variables, stateManager);
  });
}

function parseEachBlocks(element, variables, stateManager) {
  const nodes = Array.from(element.childNodes);

  nodes.forEach((node, index) => {
    const expressionRegex = new RegExp(
      /\{for:each (.*?)(?:, (.*))? of (.*?)\}/
    );

    if (
      node.nodeType === Node.TEXT_NODE &&
      expressionRegex.test(node.nodeValue)
    ) {
      const match = node.nodeValue.match(expressionRegex);

      if (!match) return;

      const itemName = match[1].trim();
      const indexName = match[2]?.trim() || "index";
      const arrayName = match[3].trim();

      const nodeChildren = nodes.slice(index);
      const eachContent = node.nextElementSibling;
      const parentNode = node.parentNode;

      const arrayOfItems = variables[arrayName];

      // gotta handle each expression for nested for each
      if (!Array.isArray(arrayOfItems)) {
        return console.error(
          `${arrayName}: is not an array at ${node.nodeValue.trim()}`
        );
      }

      // Create a tracking state for the block
      const state = {
        items: arrayOfItems,
        domNodes: [], // Tracks rendered DOM nodes
      };

      // Register reactive updates
      const update = () => {
        // Handle additions, removals, or reordering
        const newItems = variables[arrayName];

        // set oldNodes
        const oldNodeMap = new Map(
          state.domNodes.map(
            ({ node, data, stateProxy, localManager }, index) => {
              return [data.item, { node, data, stateProxy, localManager }];
            }
          )
        );

        const newDomNodes = [];

        newItems.forEach((item, index) => {
          const localContext = {
            [itemName]: item,
            [indexName]: index,
          };

          const localManager = new ReactiveState(localContext);
          const localProxy = localManager.proxy;

          const stateProxy = createLocalProxy(
            localProxy,
            variables,
            stateManager
          );

          if (oldNodeMap.has(item)) {
            const { node, data, stateProxy, localManager } =
              oldNodeMap.get(item);

            if (data.index != index) {
              // update index binding for node(via proxy)
              stateProxy[indexName] = index;
              localManager[indexName] = index;
            }

            let newData =
              typeof data.item == "object" ? structuredClone(item) : item;

            localManager[itemName] = newData;

            // save new data
            newDomNodes.push({
              node,
              data: { item, index },
              stateProxy,
              localManager,
            });
            oldNodeMap.delete(item);
          } else {
            if (newItems.length === state.domNodes.length) return; // doesn't add or remove if array is the same length

            const node = eachContent.cloneNode(true); // cloned node

            parseNode(node, stateProxy, localManager);

            newDomNodes.push({
              node,
              data: { item, index },
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
          parentNode.appendChild(node_placeholder);
        }

        // update state
        state.domNodes = newDomNodes;
        state.items = newItems;
      };

      if (eachContent) {
        // intial render
        update();
        // Register for reactive updates
        const { unsubscribe } = registerDependencies(
          `{${arrayName}}`,
          variables,
          update,
          stateManager
        );
      }

      // cleanup synthax
      nodeChildren.forEach((node) => node.remove());
    }
  });

  nodes.forEach((child) => {
    parseEachBlocks(child, variables, stateManager);
  });
}

// utils
function getNodeRange(nodes, condition) {
  return nodes.reduce(
    (newArray, element) => {
      if (newArray.stopped) return newArray;
      if (condition(element)) {
        newArray.stopped = true;
      } else {
        newArray.result.push(element);
      }
      return newArray;
    },
    { result: [], stopped: false }
  ).result;
}

function registerDependencies(template, variables, callback, stateManager) {
  const expressions = template.match(braceRegex);

  let unsub;
  expressions.forEach((expression) => {
    const tokens = expression
      .trim()
      .split(/[^a-zA-Z_$\.]+/)
      .filter(Boolean);

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
        let check =
          variables.hasOwnProperty(token) ||
          variables?.__globalState?.hasOwnProperty(token);

        return check || false;
      });

    if (filteredTokens.length == 1) {
      filteredTokens.forEach((token) => {
        if (variables?.__globalState?.hasOwnProperty(token)) {
          unsub = variables.__globalManager.subscribe(token, callback);
        } else unsub = stateManager.subscribe(token, callback);
      });
    }
    // saves update for an expression that depends on multiple state properties(if at least one changes update is triggered)
    else {
      if (
        filteredTokens.some((token) =>
          variables?.__globalState?.hasOwnProperty(token)
        )
      ) {
        unsub = variables.__globalManager.addExpression(
          filteredTokens,
          callback
        );
      } else unsub = stateManager.addExpression(filteredTokens, callback);
    }
  });

  return unsub;
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
