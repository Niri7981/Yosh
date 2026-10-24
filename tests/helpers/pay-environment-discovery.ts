import { globSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import ts from 'typescript';

// These are the existing prepared-artifact seams. Inspect literal paths rather
// than comments or filenames, and follow test helpers without importing them.
const preparedPayPath = /^(?:(?:\.\.\/)*build\.noindex\/pay-|\.\.\/pay\/rust\/|\.\.\/round2-baseline\/)/;

export function classifyPayEnvironmentSuites(suites: readonly string[], read: (path: string) => string | undefined): string[] {
  const dependencies = new Map<string, string[]>();
  const external = new Set<string>();
  function inspect(file: string) {
    if (dependencies.has(file)) return;
    const text = read(file);
    if (text === undefined) return;
    const imports: string[] = [];
    dependencies.set(file, imports);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isStringLiteralLike(node) && preparedPayPath.test(node.text)) external.add(file);
      if (ts.isTemplateExpression(node) && preparedPayPath.test(node.head.text)) external.add(file);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const reference of ts.preProcessFile(text, true, true).importedFiles) {
      if (!reference.fileName.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), reference.fileName));
      if (!base.startsWith('tests/')) continue;
      const dependency = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]
        .find(candidate => read(candidate) !== undefined);
      if (dependency) { imports.push(dependency); inspect(dependency); }
    }
  }
  suites.forEach(inspect);
  let previousSize: number;
  do {
    previousSize = external.size;
    for (const [file, imports] of dependencies) {
      if (imports.some(dependency => external.has(dependency))) external.add(file);
    }
  } while (external.size !== previousSize);
  return suites.filter(file => external.has(file)).sort();
}

export function findPayEnvironmentSuites(root: string): string[] {
  return classifyPayEnvironmentSuites(globSync('tests/**/*.test.{ts,mjs}', { cwd: root }), file => {
    try { return readFileSync(resolve(root, file), 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) return undefined;
      throw error;
    }
  });
}
