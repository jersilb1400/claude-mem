const start = Date.now();

function ts(): string {
  const s = ((Date.now() - start) / 1000).toFixed(1).padStart(5, " ");
  return `[+${s}s]`;
}

export const log = {
  stage(name: string) {
    console.log(`\n${ts()} ━━ ${name} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  },
  info(msg: string) {
    console.log(`${ts()}    ${msg}`);
  },
  ok(msg: string) {
    console.log(`${ts()} ✓  ${msg}`);
  },
  warn(msg: string) {
    console.warn(`${ts()} !  ${msg}`);
  },
};
