// One rule for small dollar amounts on every surface (CLI, slash commands, receipt; lib/client.js keeps a pinned copy):
// exact zero is $0.00, a real charge below $0.0001 is "<$0.0001" (never shown as zero), 4 decimals under $1, 2 from $1.
export const fmtUsdSmall = (n) => (!(n > 0) ? "$0.00" : n < 0.0001 ? "<$0.0001" : "$" + n.toFixed(n >= 1 ? 2 : 4));
