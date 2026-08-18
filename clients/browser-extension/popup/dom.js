(function (root) {
  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    const element = document.createElement('span');
    element.textContent = value;
    return element.innerHTML;
  }

  root.MCPopupDom = { byId, escapeHtml };
})(globalThis);
