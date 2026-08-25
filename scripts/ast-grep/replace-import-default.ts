import { tsx } from '@ast-grep/napi';
import MagicString from 'magic-string';

/** Replace the local variable name of a default import and its call sites. */
export const replaceImportDefault = (source: string, pkgName: string, expectedLocalName: string): string => {
  const magic = new MagicString(source);
  const root = tsx.parse(source).root();
  const importNode = root.find({
    rule: {
      pattern: `import $LOCAL from '${pkgName}';`,
    },
  });

  if (!importNode) {
    return source;
  }

  const localNode = importNode.getMatch('LOCAL');
  if (!localNode) {
    return source;
  }

  const localNodeText = localNode.text();
  const range = localNode.range();
  magic.overwrite(range.start.index, range.end.index, expectedLocalName);

  const matches = root.findAll({
    rule: {
      kind: 'call_expression',
      pattern: `${localNodeText}($$$)`,
    },
  });

  for (const match of matches) {
    const callee = match.child(0);
    if (!callee || callee.kind() !== 'identifier') {
      continue;
    }

    const calleeRange = callee.range();
    magic.overwrite(calleeRange.start.index, calleeRange.end.index, expectedLocalName);
  }

  return magic.toString();
};
