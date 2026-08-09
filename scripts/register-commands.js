// 手動註冊 slash 指令：npm run register
// 平常不需要手動跑——機器人上線 / 加入伺服器時會「即時」自動註冊到每台伺服器（見 src/bot/index.js）。
// 這支腳本用於：機器人沒開時想先把指令鋪好，或想把全域指令清乾淨。
require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { commands } = require('../src/bot/commands');

const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ 請先在 .env 設定 DISCORD_TOKEN、DISCORD_CLIENT_ID');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    // 清掉全域指令：改用「每台伺服器直接註冊」，避免全域＋伺服器兩份重複顯示、也不必等 1 小時。
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
    console.log('✅ 已清空全域指令（改由機器人上線時即時註冊到各伺服器）');

    // 對機器人待過的每台伺服器即時註冊（立即生效）
    let gids = [];
    try { gids = require('../src/db').activeGuildIds(); } catch {}
    for (const gid of gids) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, gid), { body: commands }).catch(e => console.error(`  ↳ ${gid} 註冊失敗：`, e.message));
      console.log(`  ↳ 已註冊 ${commands.length} 個指令到伺服器 ${gid}（立即生效）`);
    }
    if (!gids.length) console.log('（目前 db 沒有已知伺服器；機器人下次上線會自動註冊）');
  } catch (e) { console.error('註冊失敗：', e); process.exit(1); }
})();
