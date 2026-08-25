import { RuleConfigSeverity, type UserConfig } from '@commitlint/types';

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'not-chinese-message-rule': [RuleConfigSeverity.Error, 'always'],
  },
  plugins: [
    {
      rules: {
        'not-chinese-message-rule': ({ subject }) => {
          const regex = /[\u4e00-\u9fa5]+/;
          return [!regex.test(subject ?? ''), 'Please use english to rewrite your commit message'];
        },
      },
    },
  ],
};

export default config;
