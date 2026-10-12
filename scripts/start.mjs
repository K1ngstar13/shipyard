// Stop only processes verified to belong to Shipyard, then start this release.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function isShipyardRoot(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'shipyard'; }
  catch { return false; }
}
function processCwd(pid) {
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`);
    if (process.platform === 'darwin') {
      const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {encoding:'utf8'});
      return result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
    }
  } catch { /* already exited */ }
  return '';
}
export function processInventory() {
  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], {encoding:'utf8'});
    try { return [].concat(JSON.parse(result.stdout)).map(row => ({pid:row.ProcessId, ppid:row.ParentProcessId, tty:'?', command:row.CommandLine || ''})); } catch { return []; }
  }
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,tty=,command='], {encoding:'utf8'});
  return result.stdout.split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? {pid:Number(match[1]), ppid:Number(match[2]), tty:match[3], command:match[4]} : null;
  }).filter(Boolean);
}
export function verifiedShipyardProcess(row, resolveCwd = processCwd) {
  if (/\bnode(?:\.exe)?\b.*(?:scripts[\\/](?:serve|local-server)\.mjs)(?:\s|$)/.test(row.command)) {
    const cwd = resolveCwd(row.pid);
    if (cwd && isShipyardRoot(cwd)) return true;
    // New Windows launchers use an absolute script path, verifiable without cwd.
    const absolute = row.command.match(/["']?([^"']+[\\/]scripts[\\/](?:serve|local-server)\.mjs)["']?(?:\s|$)/);
    if (absolute) {
      const candidate = absolute[1].replace(/^.*?\s+(?=[A-Z]:[\\/])/, '');
      return isShipyardRoot(path.resolve(path.dirname(candidate), '..'));
    }
  }
  const shell = row.command.match(/^(?:\S*\/)?(?:bash|zsh|sh)\s+(.+\/Start Shipyard\.command)(?:\s|$)/);
  return Boolean(shell && isShipyardRoot(path.dirname(shell[1].replace(/^["']|["']$/g, ''))));
}
function closeTerminalWindows(ttys) {
  if (process.platform !== 'darwin' || !ttys.length) return;
  // A shared Terminal window may contain unrelated tabs. Exit only the matching
  // Shipyard tab there; close a whole window only when it has that one tab.
  const script = `on run wantedTTYs
    tell application "Terminal"
      repeat with w in (get windows)
        repeat with t in (get tabs of w)
          if (tty of t) is in wantedTTYs then
            if (count of tabs of w) is 1 then
              close w
            else
              do script "exit" in t
            end if
            exit repeat
          end if
        end repeat
      end repeat
    end tell
  end run`;
  const result = spawnSync('/usr/bin/osascript', ['-', ...ttys.map(tty => '/dev/' + tty)], {input:script, encoding:'utf8'});
  if (result.status !== 0) console.log('Older Shipyard stopped. Terminal window closing may need Terminal automation permission on this Mac.');
}
export async function stopPreviousShipyards({closeTerminals = true, inventory = processInventory, resolveCwd = processCwd, kill = (...args) => process.kill(...args), wait = pause, terminalCloser = closeTerminalWindows} = {}) {
  const rows = inventory(); const ancestors = new Set([process.pid]); let pid = process.ppid;
  while (pid && !ancestors.has(pid)) { ancestors.add(pid); pid = rows.find(row => row.pid === pid)?.ppid; }
  const currentTTYs = new Set(rows.filter(row => ancestors.has(row.pid)).map(row => row.tty));
  const previous = rows.filter(row => !ancestors.has(row.pid) && verifiedShipyardProcess(row, resolveCwd));
  for (const row of previous) { try { kill(row.pid, 'SIGTERM'); } catch { /* stopped */ } }
  if (previous.length) {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (previous.every(row => { try { kill(row.pid, 0); return false; } catch { return true; } })) break;
      await wait(100);
    }
    // Recheck identity before a force stop so a recycled process ID is safe.
    const live = inventory();
    for (const row of previous) {
      const current = live.find(item => item.pid === row.pid && item.command === row.command);
      if (current && verifiedShipyardProcess(current, resolveCwd)) { try { kill(row.pid, 'SIGKILL'); } catch { /* stopped */ } }
    }
    console.log(`Stopped ${previous.length} older Shipyard process${previous.length === 1 ? '' : 'es'}.`);
    if (closeTerminals) terminalCloser([...new Set(previous.map(row => row.tty).filter(tty => tty !== '?' && tty !== '??' && !currentTTYs.has(tty)))]);
  }
  return previous.map(row => row.pid);
}
async function start() {
  await stopPreviousShipyards();
  if (process.argv.includes('--stop-only')) return;
  const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs'), '--open'], {cwd:ROOT, stdio:'inherit'});
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!server.killed) server.kill(signal); });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.on('exit', code => { process.exitCode = code || 0; });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
