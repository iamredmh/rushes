import ts from "typescript";

// What would pull zod or Node into the web bundle: any import or export declaration that names a
// module (including `export * as ns from`, `import x = require()` and type-only ones), a dynamic
// import(), or a require() call. Found by walking the syntax tree, so formatting can't hide one.
// Each is returned as written, quotes and all: `"./labels.js"`.
export function modulesPulledIn(text: string): string[] {
  const sf = ts.createSourceFile("file.ts", text, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) found.push(n.moduleSpecifier.getText(sf));
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) found.push(n.moduleReference.getText(sf));
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.getText(sf));
    else if (ts.isImportTypeNode(n)) found.push(n.getText(sf));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}
