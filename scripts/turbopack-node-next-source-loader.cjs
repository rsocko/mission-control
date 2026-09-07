// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript');

module.exports = function transformNodeNextTypeScript(source) {
  const extensionlessSource = source.replace(
    /((?:from|import)\s*\(?\s*["'])(\.\.?\/[^"']+)\.js(["'])/g,
    '$1$2$3',
  );
  return ts.transpileModule(extensionlessSource, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: this.resourcePath,
  }).outputText;
};
