// 訂閱付費牆：給「不是靠指令觸發」的功能模組用的小工具。
//
// bot/index.js 的攔截器只看得到 slash 指令與按鈕／下拉，攔不到事件型功能 ——
// 關鍵字回覆、歡迎訊息、生日祝賀、表情身分組、排程公告、排程提醒、聊天等級
// 這些是 messageCreate／guildMemberAdd／cron 觸發的，沒有互動可以擋。
// 那些模組在動作前呼叫 allowed()，方案沒包含就安靜跳過（事件型功能不適合
// 對玩家喊「請續費」——那會變成洗頻）。
const { botRole } = require('./roles');
const { hasFeature } = require('../subscription');

// 這台伺服器現在能不能跑這個功能（hasFeature 會自己處理 BOT_ROLE=both）
function allowed(guildId, featureKey) {
  if (!guildId) return true;
  try { return hasFeature(guildId, botRole(), featureKey); }
  catch { return true; }        // 判定壞掉時寧可放行，不要整個功能靜默消失
}

module.exports = { allowed };
