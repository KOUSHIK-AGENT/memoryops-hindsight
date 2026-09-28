// Tiny shared helpers for the memory scripts.
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Select the bank BEFORE server.mjs is imported (it reads HINDSIGHT_BANK_ID at load time).
// A bank must be named explicitly so development runs never write to the demo bank by accident.
export async function loadMemoryApi(bank, usage) {
  if (!bank || bank === true) {
    console.error(`A memory bank is required.\n${usage}`);
    process.exit(2);
  }
  process.env.HINDSIGHT_BANK_ID = String(bank);
  return import("../server.mjs");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// End a script with an exit code WITHOUT process.exit(): on Windows, force-exiting while fetch
// sockets are still closing can crash Node (UV_HANDLE_CLOSING assertion). Scripts wrap their body in
// try { ... } catch (e) { if (!(e instanceof Stop)) throw e; } and let the event loop drain.
export class Stop extends Error {}
export function stop(code) {
  process.exitCode = code;
  throw new Stop();
}
