const { execSync } = require('child_process');

try {
  const psCmd = "Get-CimInstance Win32_Process -Filter \\\"Name = 'chrome.exe'\\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json";
  const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const data = JSON.parse(out);
  const list = Array.isArray(data) ? data : [data];
  
  const puppeteerProcesses = list.filter(p => {
    const cmd = p.CommandLine || '';
    return cmd.includes('--remote-allow-origins=*') || cmd.includes('--disable-gpu') && cmd.includes('--no-sandbox');
  });

  console.log(`Total Chrome processes on host: ${list.length}`);
  console.log(`Puppeteer / Test Chrome processes active: ${puppeteerProcesses.length}`);

  if (puppeteerProcesses.length > 0) {
    console.error('ORPHANED CHROME PROCESSES FOUND:');
    puppeteerProcesses.forEach(p => console.error(`  PID ${p.ProcessId}: ${p.CommandLine}`));
    process.exit(1);
  } else {
    console.log('✓ ZERO ORPHANED TEST CHROME PROCESSES.');
    process.exit(0);
  }
} catch (e) {
  console.error('Error checking chrome processes:', e.message);
  process.exit(2);
}
