import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
export function findUnlocalizedUi(root = process.cwd()) {
	const paths = [];
	function walk(p) {
		for (const f of fs.readdirSync(p, { withFileTypes: true })) {
			const p2 = path.join(p, f.name);
			if (f.isDirectory()) walk(p2);
			else if (p2.endsWith('.ts')) paths.push(p2);
		}
	}
	walk(path.join(root, 'src/vs/workbench/contrib/sidexChat'));
	paths.push(path.join(root, 'src/vs/workbench/contrib/scm/browser/git.contribution.ts'));
	const ui = [];
	for (const file of paths) {
		const raw = fs.readFileSync(file, 'utf8');
		const ast = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
		function inNls(n) {
			while (n) {
				if (ts.isCallExpression(n) && /\blocalize2?$/.test(n.expression.getText(ast))) return true;
				n = n.parent;
			}
			return false;
		}
		function allowed(n) {
			const p = n.parent;
			if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) return allowed(p);
			if (
				ts.isBinaryExpression(p) &&
				[ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
					p.operatorToken.kind
				)
			)
				return allowed(p);
			if (ts.isTemplateSpan(p) && p.expression === n) return allowed(p.parent);

			if (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
				const lhs = p.left.getText(ast);
				return /\.(textContent|innerText|placeholder|title|ariaLabel|tooltip|alt)$/.test(lhs) && !/style/i.test(lhs);
			}
			if (ts.isPropertyAssignment(p) && p.initializer === n) {
				if (
					p.name.getText(ast) === 'detail' &&
					ts.isObjectLiteralExpression(p.parent) &&
					ts.isNewExpression(p.parent.parent) &&
					p.parent.parent.expression.getText(ast) === 'CustomEvent'
				)
					return false;
				return /^(label|title|description|detail|message|tooltip|placeHolder|placeholder|ariaLabel|prompt|alt)$/.test(
					p.name.getText(ast).replace(/['"]/g, '')
				);
			}
			if (ts.isCallExpression(p)) {
				const name = p.expression.getText(ast);
				const index = p.arguments.indexOf(n);
				if (
					/(?:_createToggleRow|_createDropdownRow|_createNumberWithDropdownRow|_createInputRow|_createToggleRowWithBadge|_createRow|_addToggleRow|_addSelectRow)$/.test(
						name
					)
				)
					return (
						index === 1 ||
						index === 2 ||
						(name.endsWith('_createInputRow') && index === 5) ||
						(name.endsWith('_createToggleRowWithBadge') && index === 6)
					);
				if (name.endsWith('_createSectionTitle')) return index === 1;
				if (name.endsWith('_showToast')) return index === 0;
				if (name.endsWith('.setAttribute'))
					return index === 1 && ['title', 'aria-label', 'placeholder'].includes(p.arguments[0].text);
				if (/(?:^|\.)(prompt|confirm|alert)$/.test(name)) return index === 0;
				if (name === 'registerColor') return index === 2;
				if (/\.(error|warn|info)$/.test(name) && !/console|log/.test(name)) return index === 0;
			}
			if (ts.isNewExpression(p) && p.expression.getText(ast) === 'TauriGitResourceGroup')
				return p.arguments.indexOf(n) === 1;
			return false;
		}
		function visit(n) {
			if ((ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) && !inNls(n) && allowed(n)) {
				let message,
					expressions = [];
				if (ts.isTemplateExpression(n)) {
					message = n.head.text;
					for (const s of n.templateSpans) {
						message += '{' + expressions.length + '}' + s.literal.text;
						expressions.push(s.expression.getText(ast));
					}
				} else message = n.text;
				if (/[a-zA-Z]/.test(message) && !/^https?:/.test(message))
					ui.push({
						file: path.relative(root, file),
						start: n.getStart(ast),
						end: n.end,
						message,
						expressions,
						context: n.parent.getText(ast).slice(0, 400)
					});
			}
			ts.forEachChild(n, visit);
		}
		visit(ast);
	}
	return ui;
}
