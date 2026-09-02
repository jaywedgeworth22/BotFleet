const fs = require('fs');
const botsPath = require('os').homedir() + '/.botfleet/bots.json';
const bots = JSON.parse(fs.readFileSync(botsPath, 'utf8'));

let changed = false;
for (const [id, bot] of Object.entries(bots)) {
  if (bot.modelSelection && bot.modelSelection.instanceId === 'codex') {
    bot.modelSelection.instanceId = 'antigravity';
    bot.modelSelection.model = 'gemini-2.5-pro'; // Or any valid model, they can change it later
    changed = true;
  }
}

if (changed) {
  fs.writeFileSync(botsPath, JSON.stringify(bots, null, 2));
  console.log('Patched bots.json');
}
