import { readout } from '../lib/savings.mjs';
import { insights, periodRange, summarize } from '../lib/usage.mjs';

// compareModels prices at list rates; the host reports what a reply really cost. Scaling every part keeps them adding
// up, and a reply on your own model at exactly no difference.
export function atHostCost(reply, cost) {
  if (!Number.isFinite(cost) || !(reply?.routedUsd > 0)) return reply;
  const scale = cost / reply.routedUsd;
  return Object.fromEntries(Object.entries(reply).map(([key, usd]) => [key, usd * scale]));
}

const WHAT_IF_ROWS = 3;

export function usageReport(record, period, now) {
  const summary = summarize(record, periodRange(period, now));
  const whatIf = Object.entries(summary.whatIf)
    .filter(([, [replies]]) => replies === summary.replies)
    .map(([model, [, usd]]) => ({ model, usd }))
    .sort((a, b) => a.usd - b.usd)
    .slice(0, WHAT_IF_ROWS);
  return {
    period,
    ...readout(summary),
    spendUsd: summary.observed.routedUsd,
    replies: summary.observed.replies,
    whatIf,
    insights: insights(summary),
  };
}

const usd = (value) => `$${Math.abs(value).toFixed(2)}`;
const signed = (value) => `${value < 0 ? '-' : value > 0 ? '+' : ''}${usd(value)}`;
const percent = (value) => `${Math.round(value * 100)}%`;
const INSIGHT_TEXT = {
  cost: ({ activity, tier, share }) => `${tier}/${activity} carried ${percent(share)} of the cost`,
  switch: ({ share }) => `Switch cache writes took ${percent(share)} of the cheaper-model saving`,
  stronger: ({ activity, tier, usd: spent }) => `${tier}/${activity} ran ${usd(spent)} above no routing`,
};

export function usageLines(report) {
  if (!report.replies) return [`Usage (${report.period}): no replies yet`];
  const { spendUsd, replies, early, routedUsd, yoursUsd, differenceUsd, share } = report;
  const lines = [`Usage (${report.period}): ${usd(spendUsd)} over ${replies} replies${early ? ' · early sample' : ''}`];
  const change = share === null ? '' : ` (${share < 0 ? '-' : '+'}${percent(Math.abs(share))})`;
  lines.push(`Routing vs no routing: ${usd(routedUsd)} vs ${usd(yoursUsd)} · ${signed(differenceUsd)}${change}`);
  lines.push(
    `Cheaper models ${signed(report.cheaperUsd)} · stronger ${signed(report.strongerUsd)} · switches ${signed(report.switchUsd)}`,
  );
  if (report.whatIf?.length)
    lines.push(`What if: ${report.whatIf.map((row) => `${row.model} ${usd(row.usd)}`).join(' · ')}`);
  if (report.agreement?.total) {
    const { matched, total } = report.agreement;
    const wait = report.latency ? ` · p95 ${(report.latency.ms / 1000).toFixed(1)}s` : '';
    lines.push(`Classifier agreed on ${matched} of ${total} turns${wait}`);
  }
  for (const insight of report.insights ?? []) lines.push(INSIGHT_TEXT[insight.kind]?.(insight));
  return lines;
}
