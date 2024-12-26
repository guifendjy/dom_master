# DOM MASTER
dom_master: A Lightweight DOM Manipulation and Reactive Framework

dom_master is a minimal, vanilla JavaScript library designed to simplify 
dynamic DOM manipulation and create reactive user interfaces without the 
overhead of large frameworks. A little unconventional, it uses string literals to 
describe the UI, it uses TEXT_NODEs to enable users to conditionally render elements.
tho it gets the job done, it is limited, it does not work with elements with strict structures.

## Key Features
	•	Reactive State Management: Bind data to the DOM and automatically update elements when state changes.
	•	Dynamic Rendering: Effortlessly handle loops (for:each, start:if) and conditional rendering with intuitive syntax.
	•	Fine-Grained Updates: Efficiently update only the necessary DOM elements to ensure high performance.
	•	No Build Tools: Works directly in the browser—no need for bundlers or transpilers.
	•	Custom Interactivity: Provides local state for dynamically created nodes, ensuring scoped reactivity.
 
## CDN
Add following script tag to yout HTML file:
```html
<script src="https://cdn.jsdelivr.net/gh/guifendjy/dom_master@v1.0.0/dommaster.js"></script>
```
## Usage Example
```javascript
// master is available globally via the window Object.

// defining reactive state
const state = new master.ReactiveState({
  count: 0,
  styles: `
    font-weight: bold;
    color: orangered;
    `,
  increment: () => {
    state.count++;
  },
  decrement: () => !state.count <= 0 && state.count--,
});
```
## Template - UI
```javascript
// Step 2: Define a template
const template = `
  <div class="box">
      <div>
          <p style="{styles}">
              count: {count} - one up: {count + 1}
          </p>
          <button class="btn" id="add" onclick="increment">increment</button>
          <button disabled="{count <= 0}"  class="btn" onclick="decrement">decrement</button>
          {start:if count > 0}
              <p>if condition is true: <span style="font-weight: bold;">{count}</span> times</p>
          {end:if}
      </div>
  </div>
    `;
```

## CreateElement

```javascript
let counter = master.createElement(template, state);

// append to the dom
document.body.appendChild(counter);
```
Perfect for small-to-medium personal projects. 

feel free to try dom_master today!

