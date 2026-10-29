import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function literalText(node) {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const left = literalText(node.left);
		const right = literalText(node.right);
		if (left !== undefined && right !== undefined) return left + right;
	}
	return undefined;
}

/** Parse the actual TypeScript syntax: comments and strings are never executable NLS calls. */
export function collectNlsCalls(code, filename) {
	const source = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true);
	const calls = [];
	function visit(node) {
		if (ts.isCallExpression(node)) {
			const name = ts.isIdentifier(node.expression)
				? node.expression.text
				: ts.isPropertyAccessExpression(node.expression)
					? node.expression.name.text
					: undefined;
			if ((name === 'localize' || name === 'localize2') && node.arguments.length >= 2) {
				const first = node.arguments[0];
				let key = literalText(first);
				if (ts.isObjectLiteralExpression(first)) {
					const property = first.properties.find(
						property =>
							ts.isPropertyAssignment(property) && property.name.getText(source).replace(/['"]/g, '') === 'key'
					);
					key = property && literalText(property.initializer);
				}
				const message = literalText(node.arguments[1]);
				if (typeof key === 'string' && typeof message === 'string') {
					calls.push({ key, message, start: first.getStart(source), end: first.end });
				}
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return calls;
}

export function moduleId(filename, root = process.cwd()) {
	return relative(resolve(root, 'src'), filename)
		.replace(/\\/g, '/')
		.replace(/\.[cm]?[jt]sx?$/, '');
}

export function collectNlsEntries(root = process.cwd()) {
	const entries = [];
	function walk(directory) {
		for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name, 'en')
		)) {
			const filename = join(directory, item.name);
			if (item.isDirectory()) {
				if (item.name !== 'test') walk(filename);
			} else if (filename.endsWith('.ts')) {
				const code = readFileSync(filename, 'utf8');
				if (!code.includes('localize')) continue;
				for (const call of collectNlsCalls(code, filename)) {
					entries.push({ module: moduleId(filename, root), key: call.key, message: call.message });
				}
			}
		}
	}
	walk(resolve(root, 'src/vs'));
	return entries;
}

export function placeholders(message) {
	return [...new Set([...message.matchAll(/\{(\d+)\}/g)].map(match => match[1]))].sort().join(',');
}
