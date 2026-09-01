'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SENTINEL = 'somewhere:v1';
const MODULE_NAME = 'somewhere:api';
const MANIFEST_PATH = '_internal/typed-functions.json';
const AMBIENT_FILE = '__somewhere_typed_functions.d.ts';
const CLIENT_FILE = '__somewhere_api.d.ts';

// One route-independent helper. Procedure paths exist only in the declaration
// and release manifest; adding a procedure adds zero browser JavaScript.
const RUNTIME_SOURCE = `class FunctionError extends Error{constructor(status,payload){super(payload&&typeof payload.message==="string"?payload.message:"Server function failed");this.name="FunctionError";this.status=status;this.code=payload&&typeof payload.code==="string"?payload.code:null}}const invoke=async(parts,input)=>{const response=await fetch("/api/"+parts.join("/"),{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:input===undefined?undefined:JSON.stringify(input)});const payload=await response.json().catch(()=>({}));if(!response.ok)throw new FunctionError(response.status,payload);return payload};const branch=parts=>new Proxy(()=>{},{get:(_,part)=>part==="then"?undefined:branch([...parts,String(part)]),apply:(_,__,args)=>invoke(parts,args[0])});const api=branch([]);export{api,FunctionError};`;

const GLOBAL_TYPES = `
type __SomewhereJsonPrimitive = string | number | boolean | null;
type __SomewhereJson = __SomewhereJsonPrimitive | { [key: string]: __SomewhereJson } | __SomewhereJson[];
interface __SomewhereTypedRequest<Input> extends Request { json(): Promise<Input> }
type ServerFunction<Contract extends { input: unknown; output: unknown }> =
  (req: __SomewhereTypedRequest<Contract["input"]>, sw: never) =>
    Contract["output"] | Promise<Contract["output"]>;
`;

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function displayFileName(sourceFile) {
  return sourceFile.__somewhereRelativeName || normalizePath(sourceFile.fileName);
}

function warning(sourceFile, node, mismatch, fix) {
  const where = lineAndColumn(sourceFile, node);
  return `Typed function warning — ${displayFileName(sourceFile)}:${where.line}:${where.column}\n${mismatch}\nFix: ${fix}\nThis deploy continued; typed-function checks are warning-only.`;
}

function hasExportModifier(ts, node) {
  return !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function exactSentinelNode(ts, sourceFile) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(ts, statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'typed') continue;
      if (declaration.initializer && ts.isAsExpression(declaration.initializer)
          && ts.isStringLiteral(declaration.initializer.expression)
          && declaration.initializer.expression.text === SENTINEL) return declaration;
      if (declaration.initializer && ts.isStringLiteral(declaration.initializer)
          && declaration.initializer.text === SENTINEL) return declaration;
    }
  }
  return null;
}

function supportedRoute(functionPath) {
  if (!functionPath.startsWith('api/') || !/\.(?:ts|tsx)$/i.test(functionPath)) return false;
  const withoutExtension = functionPath.replace(/\.(?:ts|tsx)$/i, '').slice(4);
  const segments = withoutExtension.split('/');
  return segments.length > 0 && segments.every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment));
}

function routeDetails(functionPath) {
  const segments = functionPath.replace(/\.(?:ts|tsx)$/i, '').slice(4).split('/');
  return {
    client: segments.join('.'),
    route: `/api/${segments.join('/')}`,
    segments,
  };
}

function createCompilerOptions(ts, root, tsconfigText) {
  let user = {};
  if (typeof tsconfigText === 'string') {
    const parsedText = ts.parseConfigFileTextToJson(path.join(root, 'tsconfig.json'), tsconfigText);
    if (!parsedText.error) {
      user = ts.convertCompilerOptionsFromJson(parsedText.config?.compilerOptions || {}, root).options;
    }
  }
  return {
    ...user,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: user.target ?? ts.ScriptTarget.ES2022,
    module: user.module ?? ts.ModuleKind.ESNext,
    moduleResolution: user.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
    jsx: user.jsx ?? ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
  };
}

function createProgram(ts, root, files, tsconfigText, generatedClient) {
  const ambientPath = path.join(root, AMBIENT_FILE);
  const clientPath = path.join(root, CLIENT_FILE);
  const generated = new Map([[ambientPath, GLOBAL_TYPES]]);
  const relativeNames = new Map(Object.keys(files).map((file) => [path.join(root, file), normalizePath(file)]));
  if (generatedClient) generated.set(clientPath, generatedClient);
  const options = createCompilerOptions(ts, root, tsconfigText);
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => generated.get(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) => generated.has(fileName) || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = generated.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    const disk = readFile(fileName);
    if (disk === undefined) return undefined;
    const sourceFile = ts.createSourceFile(fileName, disk, languageVersion, true);
    sourceFile.__somewhereRelativeName = relativeNames.get(fileName);
    return sourceFile;
  };
  const roots = Object.keys(files)
    .filter((file) => /\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file))
    .map((file) => path.join(root, file));
  roots.push(ambientPath);
  if (generatedClient) roots.push(clientPath);
  return ts.createProgram({ rootNames: roots, options, host });
}

function typeIssue(ts, checker, type, seen = new Set()) {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return 'any or unknown';
  if (type.flags & ts.TypeFlags.Never) return 'never';
  if (type.flags & ts.TypeFlags.Undefined) return null;
  if (type.isUnion?.()) {
    for (const member of type.types) {
      const issue = typeIssue(ts, checker, member, seen);
      if (issue) return issue;
    }
    return null;
  }
  if (type.isIntersection?.()) return 'an intersection type';
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Void)) return null;
  if (!(type.flags & ts.TypeFlags.Object)) return `non-JSON type ${checker.typeToString(type)}`;
  if (seen.has(type)) return 'a recursive type';
  seen.add(type);
  const symbolName = type.getSymbol?.()?.getName?.();
  if (symbolName === 'Date' || symbolName === 'Map' || symbolName === 'Set' || symbolName === 'Response' || symbolName === 'Blob') {
    return `non-JSON type ${symbolName}`;
  }
  const arrayElement = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (arrayElement) {
    const issue = typeIssue(ts, checker, arrayElement, seen);
    seen.delete(type);
    return issue;
  }
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration || property.declarations?.[0];
    if (!declaration) continue;
    const issue = typeIssue(ts, checker, checker.getTypeOfSymbolAtLocation(property, declaration), seen);
    if (issue) {
      seen.delete(type);
      return `${property.getName()} contains ${issue}`;
    }
  }
  seen.delete(type);
  return null;
}

function serializeType(ts, checker, type, seen = new Set()) {
  if (type.flags & ts.TypeFlags.Void) return 'void';
  if (type.flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value);
  if (type.flags & ts.TypeFlags.NumberLiteral) return String(type.value);
  if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName;
  if (type.flags & ts.TypeFlags.StringLike) return 'string';
  if (type.flags & ts.TypeFlags.NumberLike) return 'number';
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean';
  if (type.flags & ts.TypeFlags.Null) return 'null';
  if (type.flags & ts.TypeFlags.Undefined) return 'undefined';
  if (type.isUnion?.()) return type.types.map((member) => serializeType(ts, checker, member, seen)).join(' | ');
  if (seen.has(type)) return 'never';
  seen.add(type);
  const arrayElement = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (arrayElement) {
    const rendered = `Array<${serializeType(ts, checker, arrayElement, seen)}>`;
    seen.delete(type);
    return rendered;
  }
  const fields = checker.getPropertiesOfType(type).map((property) => {
    const declaration = property.valueDeclaration || property.declarations?.[0];
    const propertyType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : checker.getDeclaredTypeOfSymbol(property);
    const optional = !!(property.flags & ts.SymbolFlags.Optional);
    const name = /^[A-Za-z_$][\w$]*$/.test(property.getName()) ? property.getName() : JSON.stringify(property.getName());
    return `${name}${optional ? '?' : ''}: ${serializeType(ts, checker, propertyType, seen)}`;
  });
  seen.delete(type);
  return `{ ${fields.join('; ')} }`;
}

function exportedSymbol(checker, sourceFile, name) {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  return moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.getName() === name);
}

function defaultExportExpression(ts, sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) return statement.expression;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
  }
  return null;
}

function unwrapExpression(ts, expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function isEndpointCall(ts, expression) {
  const node = unwrapExpression(ts, expression);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  return node.expression.name.text === 'endpoint' && node.arguments.length > 0 && ts.isObjectLiteralExpression(node.arguments[0])
    ? node.arguments[0]
    : null;
}

function endpointBodyType(ts, node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return { text: 'void' };
  const fields = [];
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) return { error: 'body schema uses a computed or shorthand field' };
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (!name) return { error: 'body schema contains a field that the typed client cannot read' };
    if (ts.isObjectLiteralExpression(property.initializer)) {
      const nested = endpointBodyType(ts, property.initializer);
      if (nested.error) return { error: `${name}.${nested.error}` };
      fields.push(`${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${nested.text}`);
      continue;
    }
    if (!ts.isStringLiteral(property.initializer)) return { error: `body field ${name} is not a supported schema rule` };
    let rule = property.initializer.text;
    const optional = rule.endsWith('?');
    if (optional) rule = rule.slice(0, -1);
    const mapped = rule === 'string' || rule === 'email' ? 'string'
      : rule === 'number' ? 'number'
      : rule === 'boolean' ? 'boolean'
      : rule === 'array' ? 'unknown[]'
      : rule === 'object' ? 'Record<string, unknown>'
      : null;
    if (!mapped) return { error: `body field ${name} uses unsupported rule ${JSON.stringify(property.initializer.text)}` };
    fields.push(`${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}${optional ? '?' : ''}: ${mapped}`);
  }
  return { text: `{ ${fields.join('; ')} }` };
}

function endpointHandler(ts, objectLiteral) {
  for (const property of objectLiteral.properties) {
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (name === 'handler') {
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isMethodDeclaration(property)) return property;
    }
  }
  return null;
}

function propertyValue(ts, objectLiteral, wanted) {
  for (const property of objectLiteral.properties) {
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (name === wanted && ts.isPropertyAssignment(property)) return property.initializer;
  }
  return null;
}

function awaitedReturnType(ts, checker, node) {
  const signature = checker.getSignatureFromDeclaration(node) || checker.getSignaturesOfType(checker.getTypeAtLocation(node), ts.SignatureKind.Call)[0];
  if (!signature) return null;
  return checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
}

function bareFunctionNode(ts, expression) {
  const node = unwrapExpression(ts, expression);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) ? node : null;
}

function hasServerFunctionSatisfies(ts, expression) {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)) current = current.expression;
  if (!ts.isSatisfiesExpression(current)) return false;
  const type = current.type;
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
    && type.typeName.text === 'ServerFunction'
    && type.typeArguments?.length === 1
    && ts.isTypeReferenceNode(type.typeArguments[0])
    && ts.isIdentifier(type.typeArguments[0].typeName)
    && type.typeArguments[0].typeName.text === 'Contract';
}

function buildDeclaration(procedures) {
  const tree = {};
  for (const procedure of procedures) {
    let cursor = tree;
    for (const segment of procedure.segments.slice(0, -1)) cursor = cursor[segment] ||= {};
    cursor[procedure.segments.at(-1)] = procedure;
  }
  const render = (node, depth) => Object.entries(node).map(([name, value]) => {
    if (value && value.route) {
      const arg = value.input === 'void' ? '' : `input: ${value.input}`;
      return `${name}: (${arg}) => Promise<${value.output}>`;
    }
    return `${name}: { ${render(value, depth + 1)} }`;
  }).join('; ');
  return `declare module ${JSON.stringify(MODULE_NAME)} {\n  export class FunctionError extends Error { status: number; code: string | null }\n  export const api: { ${render(tree, 1)} };\n}\n`;
}

function importApiNames(ts, sourceFile) {
  const names = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== MODULE_NAME) continue;
    for (const element of statement.importClause?.namedBindings?.elements || []) {
      if ((element.propertyName?.text || element.name.text) === 'api') names.add(element.name.text);
    }
  }
  return names;
}

function containsRootedApiCall(ts, node, names) {
  let found = false;
  const rootName = (expression) => {
    let current = expression;
    while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)
      || ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      if (ts.isCallExpression(current)) current = current.expression;
      else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
      else current = current.expression;
    }
    return ts.isIdentifier(current) ? current.text : null;
  };
  const visit = (child) => {
    if ((ts.isCallExpression(child) || ts.isPropertyAccessExpression(child)) && names.has(rootName(child))) found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function clientWarnings(ts, program, procedures) {
  const checker = program.getTypeChecker();
  const warnings = [];
  const routeByClient = new Map(procedures.map((procedure) => [procedure.client, procedure.file]));
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('/node_modules/')) continue;
    const names = importApiNames(ts, sourceFile);
    if (!names.size) continue;
    const relevantStatements = sourceFile.statements.filter((statement) => containsRootedApiCall(ts, statement, names));
    for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
      if (diagnostic.start === undefined || !relevantStatements.some((statement) => diagnostic.start >= statement.getStart() && diagnostic.start < statement.getEnd())) continue;
      const node = relevantStatements.find((statement) => diagnostic.start >= statement.getStart() && diagnostic.start < statement.getEnd()) || sourceFile;
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const called = procedures.find((procedure) => sourceFile.text.includes(`api.${procedure.client}`));
      const contract = called ? routeByClient.get(called.client) : null;
      warnings.push(warning(sourceFile, node, message, contract
        ? `make this call match the input/output contract in ${contract}, or change that contract and its callers together.`
        : `use a procedure exported by ${MODULE_NAME}, or add the matching typed function under api/.`));
    }
  }
  return warnings;
}

function analyzeTypedFunctions(input) {
  const { root, files, functionEntries, tsconfigText } = input;
  const scanStarted = nowMs();
  const candidates = functionEntries.filter((file) => typeof files[file] === 'string' && files[file].includes(SENTINEL));
  const scanMs = nowMs() - scanStarted;
  if (!candidates.length) {
    return {
      manifest: null,
      summary: { procedures: 0, contract_digest: null, warnings: 0 },
      warnings: [],
      declaration: null,
      runtime: RUNTIME_SOURCE,
      timing_ms: { scan: scanMs, typecheck: 0, total: scanMs },
    };
  }
  const ts = input.ts || input.loadTypescript();

  const started = nowMs();
  const program = createProgram(ts, root, files, tsconfigText, null);
  const checker = program.getTypeChecker();
  const warnings = [];
  const procedures = [];
  for (const file of candidates) {
    const sourceFile = program.getSourceFile(path.join(root, file));
    if (!sourceFile) continue;
    const sentinel = exactSentinelNode(ts, sourceFile);
    if (!sentinel) continue;
    if (!supportedRoute(file)) {
      warnings.push(warning(sourceFile, sentinel,
        `This opted-in route cannot be represented by the v1 typed client (${file}).`,
        `move it to a static api/name.ts path with JavaScript-identifier segments, or remove the typed sentinel and keep calling it with fetch.`));
      continue;
    }
    const expression = defaultExportExpression(ts, sourceFile);
    if (!expression) {
      warnings.push(warning(sourceFile, sentinel, 'This opted-in file has no default server function export.',
        `add a default function export, or remove the typed sentinel and keep calling the route with fetch.`));
      continue;
    }
    const endpoint = isEndpointCall(ts, expression);
    let inputType = null;
    let outputType = null;
    let outputNode = expression;
    if (endpoint) {
      const body = endpointBodyType(ts, propertyValue(ts, endpoint, 'body'));
      if (body.error) {
        warnings.push(warning(sourceFile, propertyValue(ts, endpoint, 'body') || endpoint, `The endpoint ${body.error}.`,
          `use the documented string/email/number/boolean body rules, or remove the typed sentinel and use fetch.`));
        continue;
      }
      inputType = body.text;
      const handler = endpointHandler(ts, endpoint);
      outputNode = handler || endpoint;
      outputType = handler ? awaitedReturnType(ts, checker, handler) : null;
      if (!handler || !outputType) {
        warnings.push(warning(sourceFile, outputNode, 'The endpoint handler output type could not be read.',
          `add an explicit Promise<YourJsonShape> return type to handler, or remove the typed sentinel.`));
        continue;
      }
    } else {
      if (!hasServerFunctionSatisfies(ts, expression)) {
        warnings.push(warning(sourceFile, expression,
          'This bare opted-in handler is missing satisfies ServerFunction<Contract>.',
          `export type Contract with input/output fields and add satisfies ServerFunction<Contract> to the default handler.`));
        continue;
      }
      const contractSymbol = exportedSymbol(checker, sourceFile, 'Contract');
      const contractDeclaration = contractSymbol?.declarations?.[0];
      const contractType = contractSymbol && contractDeclaration ? checker.getDeclaredTypeOfSymbol(contractSymbol) : null;
      const inputProperty = contractType && checker.getPropertyOfType(contractType, 'input');
      const outputProperty = contractType && checker.getPropertyOfType(contractType, 'output');
      if (!contractDeclaration || !inputProperty || !outputProperty) {
        warnings.push(warning(sourceFile, expression, 'Contract must export both input and output types.',
          `export type Contract = { input: YourInput; output: YourJsonOutput }.`));
        continue;
      }
      const input = checker.getTypeOfSymbolAtLocation(inputProperty, contractDeclaration);
      const output = checker.getTypeOfSymbolAtLocation(outputProperty, contractDeclaration);
      const handler = bareFunctionNode(ts, expression);
      const actualOutput = handler ? awaitedReturnType(ts, checker, handler) : null;
      if (actualOutput && !checker.isTypeAssignableTo(actualOutput, output)) {
        warnings.push(warning(sourceFile, handler,
          `This function promises ${checker.typeToString(output)} but returns ${checker.typeToString(actualOutput)}.`,
          `return the promised shape, or update Contract["output"] and its browser callers.`));
      }
      inputType = input;
      outputType = output;
    }

    if (typeof inputType !== 'string') {
      const issue = typeIssue(ts, checker, inputType);
      if (issue) {
        warnings.push(warning(sourceFile, expression, `The public input contains ${issue}; publishing it as typed would be unsafe.`,
          `replace that boundary with an explicit JSON-serializable input type.`));
        continue;
      }
      inputType = serializeType(ts, checker, inputType);
    }
    const outputIssue = typeIssue(ts, checker, outputType);
    if (outputIssue) {
      warnings.push(warning(sourceFile, outputNode, `The public output contains ${outputIssue}; publishing it as typed would be unsafe.`,
        endpoint
          ? `add an explicit JSON-serializable Promise<Output> annotation to handler.`
          : `replace Contract["output"] with an explicit JSON-serializable type.`));
      continue;
    }
    const outputText = serializeType(ts, checker, outputType);
    const details = routeDetails(file);
    procedures.push({
      file,
      client: details.client,
      route: details.route,
      segments: details.segments,
      input: inputType,
      output: outputText,
    });
  }

  procedures.sort((a, b) => a.client.localeCompare(b.client));
  for (let index = 1; index < procedures.length; index++) {
    if (procedures[index - 1].client === procedures[index].client) {
      const file = program.getSourceFile(path.join(root, procedures[index].file));
      warnings.push(warning(file, file, `Two typed functions generate the same client name api.${procedures[index].client}.`,
        `rename one function file so every typed procedure has a unique static path.`));
    }
  }
  const declaration = buildDeclaration(procedures);
  const clientProgram = createProgram(ts, root, files, tsconfigText, declaration);
  warnings.push(...clientWarnings(ts, clientProgram, procedures));
  const digestInput = procedures.map(({ client, route, input: procedureInput, output }) => ({ client, route, input: procedureInput, output }));
  const manifestProcedures = procedures.map(({ file, client, route, input: procedureInput, output }) => ({ file, client, route, input: procedureInput, output }));
  const contractDigest = crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  const typecheckMs = nowMs() - started;
  const manifest = procedures.length || warnings.length ? {
    version: 1,
    contract_digest: contractDigest,
    procedures: manifestProcedures,
    declaration,
  } : null;
  return {
    manifest,
    summary: { procedures: procedures.length, contract_digest: contractDigest, warnings: warnings.length },
    warnings,
    declaration,
    runtime: RUNTIME_SOURCE,
    timing_ms: { scan: scanMs, typecheck: typecheckMs, total: scanMs + typecheckMs },
  };
}

function virtualApiPlugin(esbuild) {
  return {
    name: 'somewhere-typed-api',
    setup(build) {
      build.onResolve({ filter: /^somewhere:api$/ }, () => ({ path: MODULE_NAME, namespace: 'somewhere-typed-api' }));
      build.onLoad({ filter: /.*/, namespace: 'somewhere-typed-api' }, () => ({ contents: RUNTIME_SOURCE, loader: 'js' }));
    },
  };
}

module.exports = {
  AMBIENT_FILE,
  CLIENT_FILE,
  MANIFEST_PATH,
  MODULE_NAME,
  RUNTIME_SOURCE,
  SENTINEL,
  analyzeTypedFunctions,
  buildDeclaration,
  exactSentinelNode,
  supportedRoute,
  virtualApiPlugin,
};
