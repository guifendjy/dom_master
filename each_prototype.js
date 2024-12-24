Array.prototype.each = function (callback = () => {}) {
  let originalArray = this;

  let UI = originalArray
    .map((item, index) => {
      return callback(item, index);
    })
    .join("");
  return UI;
};
