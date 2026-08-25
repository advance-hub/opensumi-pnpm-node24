import { replaceImportDefault } from '../../ast-grep/replace-import-default.ts';

import type { Rule } from 'eslint';

const packageName = 'classnames';
const expectedLocalName = 'cls';

const rule: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: `Enforce a consistent import name for the "${packageName}" library`,
    },
    messages: {
      unexpectedImportName: `Expected "${packageName}" to be imported as "${expectedLocalName}".`,
    },
    fixable: 'code',
    schema: [],
  },
  create: (context) => ({
    ImportDeclaration(node) {
      if (node.source.value !== packageName) {
        return;
      }

      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportDefaultSpecifier' || specifier.local.name === expectedLocalName) {
          continue;
        }

        context.report({
          node: specifier.local,
          messageId: 'unexpectedImportName',
          fix: (fixer) => {
            const sourceCode = context.sourceCode;
            const result = replaceImportDefault(sourceCode.text, packageName, expectedLocalName);
            return fixer.replaceTextRange([0, sourceCode.text.length], result);
          },
        });
      }
    },
  }),
};

export default rule;
