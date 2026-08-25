import type { CSSProperties } from 'react';

const lineHeight = 20;

type MentionBoxStyle = CSSProperties & {
  '--comments-mention-min-height': string;
  '--comments-mention-max-height': string;
};

export const getMentionBoxStyle = ({ maxRows = 10, minRows = 2 }): MentionBoxStyle => ({
  fontSize: 12,
  '--comments-mention-min-height': `${lineHeight * minRows}px`,
  '--comments-mention-max-height': `${lineHeight * maxRows}px`,
});
