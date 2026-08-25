import fs from 'fs';
import path from 'path';

import chalk from 'chalk';

import { argv } from '../packages/core-common/src/node/cli';

import { getPrList } from './changelog/github';
import { formatBytes, getChangelog } from './changelog/util';

if (!process.env.GITHUB_TOKEN) {
  console.log(chalk.red('Please export your github personal access token as env `GITHUB_TOKEN`'));
  console.log(chalk.green('You can access your own access token by https://github.com/settings/tokens'));
  console.log(chalk.yellow('Please keep your github access token carefully'));
  process.exit();
} else if (!argv.time || !argv.branch) {
  console.log(chalk.yellow('Please process a time argv, like `pnpm run iteration --time=2022-2-2 --branch=2.18`'));
  process.exit();
}

// 当前仅会统计已合并的 PR 用于最初的迭代计划内容初始化，后续内容需要手动调整
(async () => {
  const time = argv.time as string;
  const version = argv.branch as string;
  const items = await getPrList(new Date(time).getTime());
  const draftLog: string[] = [];
  for (const item of items) {
    const changelog = getChangelog(item.body);
    if (!changelog) {
      continue;
    }
    draftLog.push(`- [x] ${changelog} [#${item.number}](${item.html_url}). [@${item.user.login}](${item.user.url})`);
  }

  const plan = `<!-- This plan captures our work in February. This is a 3-week iteration. We will ship in mid-April. -->

# Plan Items

Legend of annotations:

|  Mark   | Description  |
|  ----  | ----  |
|🏃| work in progress |
|✋| blocked task |
|💪| stretch goal for this iteration |
|👨🏻‍💻| a large work item, larger than one iteration |
|🐚| under discussion within the team |

Below is a summary of the top-level plan items.

## [Draft]
<!-- 发布前需要对 PR 进行分类, 标注 emoji 信息，同时移除多余的分类信息，下列部分仅为迭代期间合并的 PR，还有部分信息需要手动补充 -->
${draftLog.join('\n')}

## Editor

## Extension Manager

## FileTree

## Debug

## Webview

## Search

## Terminal

## Preference

## Keymaps

## Theme

## Webview

## StatusBar

## Extension API

## QuickOpen

## Refactor

## Electron

## Storage

## Style Change

## Tabbar

## Others

Release Notes 见：[release-notes/v${version}.md](https://github.com/opensumi/doc/blob/main/release-notes/v${version}.md).
`;

  const logFile = path.resolve(__dirname, '../iteration-plan.md');
  await fs.promises.writeFile(logFile, plan);
  const bytes = Buffer.byteLength(plan, 'utf8');
  console.log(`${formatBytes(bytes)} written to ${logFile}\n`);
})();
