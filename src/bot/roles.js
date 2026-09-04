// 機器人角色拆分：同一份程式碼，用 BOT_ROLE 決定「這個行程是哪一隻機器人」。
//
// 為什麼不拆成兩個專案：兩隻共用 db、後台、星幣、伺服器登錄與訂閱判定，
// 拆檔案只會讓共用邏輯開始分岔（改了 A 忘了改 B）。這裡只做兩件事：
//   ① 只載入自己那一半的功能模組 → 秘書不會跑遊戲排程，管家不會佔語音
//   ② 只註冊自己那一半的 slash 指令 → 順便解掉「單一機器人 100 個指令上限」
//
//   secretary（璃白Yu光秘書）＝功能型：音樂、抽獎、投票、客服單、論壇、歡迎、等級…
//   butler   （璃白Yu光管家）＝遊戲型：冒險、農牧、家園、股市、稅務、拍賣…
//   both     ＝舊的單機器人模式（沒設 BOT_ROLE 時的相容值，全部照舊載入）

const SECRETARY_FEATURES = [
  'keywords', 'alerts', 'forum', 'reactionroles', 'welcome', 'birthday',
  'announcements', 'poll', 'giveaway', 'wheel', 'postwheel', 'reminder', 'music', 'tickets', 'xp'
];

const BUTLER_FEATURES = [
  'gather', 'facility', 'ranch', 'aquarium', 'special', 'trades', 'crops', 'stock',
  'tax', 'charity', 'auction', 'contest', 'loans', 'home', 'furniture', 'kitchen',
  'dex', 'pets', 'affinity', 'partnerskills', 'bank', 'help', 'panel'
];

// 目前行程扮演的角色（.env 的 BOT_ROLE）
function botRole() {
  const v = String(process.env.BOT_ROLE || 'both').toLowerCase().trim();
  return ['secretary', 'butler', 'both'].includes(v) ? v : 'both';
}

const ROLE_LABEL = { secretary: '璃白Yu光秘書', butler: '璃白Yu光管家', both: '璃白Yu光（單機器人模式）' };
function roleLabel(role = botRole()) { return ROLE_LABEL[role] || role; }

// 這個角色要載入哪些 features/*.js
function featuresFor(role = botRole()) {
  if (role === 'secretary') return [...SECRETARY_FEATURES];
  if (role === 'butler') return [...BUTLER_FEATURES];
  return [...SECRETARY_FEATURES, ...BUTLER_FEATURES];
}

// 這個角色要註冊哪些 slash 指令。
// 分法直接沿用 commands.js 既有的 GAME_COMMANDS（說明前綴【遊戲】那份），
// 不另外再維護一張名單，避免兩邊漏同步。
function commandsFor(role = botRole()) {
  const { commands, GAME_COMMANDS } = require('./commands');
  if (role === 'both') return commands;
  const wantGame = role === 'butler';
  return commands.filter(c => GAME_COMMANDS.has(c.name) === wantGame);
}

// 某個指令名該不該由這個角色處理（功能模組共用 client 事件時的保險）
function ownsCommand(name, role = botRole()) {
  const { GAME_COMMANDS } = require('./commands');
  if (role === 'both') return true;
  return GAME_COMMANDS.has(name) === (role === 'butler');
}

module.exports = { botRole, roleLabel, featuresFor, commandsFor, ownsCommand, SECRETARY_FEATURES, BUTLER_FEATURES };

// ---- 指令 → 功能鍵對照（訂閱付費牆用）----
// 沒列到的指令視為「基本功能」，任何方案都能用（例如 /幫助、/錢包、/簽到）。
const COMMAND_FEATURE = {
  // 秘書
  play: 'music', join: 'music', leave: 'music', skip: 'music', prev: 'music', pause: 'music',
  resume: 'music', stop: 'music', clear: 'music', queue: 'music', np: 'music', shuffle: 'music',
  volume: 'music', remove: 'music', move: 'music', loop: 'music',
  '抽獎': 'giveaway', '取消抽獎': 'giveaway', '貼文轉盤': 'wheel',
  '客服面板': 'tickets', '投票': 'poll', '論壇整理': 'forum',
  '等級': 'xp', '排行': 'xp',
  // 管家
  '釣魚': 'gather', '挖礦': 'gather', '伐木': 'gather', '採集': 'gather', '狩獵': 'gather',
  '製作': 'gather', '鍛造': 'gather', '配方': 'gather', '任務': 'gather', '地圖': 'gather',
  '修理': 'gather', '商店': 'gather', '購買': 'gather',
  '倉庫': 'gather', '圖鑑': 'dex', '成就': 'dex',
  '交易': 'trades', '轉帳': 'trades',
  '牧場': 'ranch', '畜牧商店': 'ranch', '飼養': 'ranch', '收成': 'ranch', '放生': 'ranch',
  '偷': 'ranch', '孵化': 'ranch', '孵化室': 'ranch',
  '魚缸': 'aquarium', '水族商店': 'aquarium', '養魚': 'aquarium', '餵魚': 'aquarium',
  '撈金': 'aquarium', '賣魚': 'aquarium', '偷魚': 'aquarium',
  '種子商店': 'crops', '種植': 'crops', '農地': 'crops', '溫室': 'crops', '採收': 'crops',
  '我的家': 'home', '升級家園': 'home', '家園卡': 'home', '家園網頁': 'home', '遊戲': 'home',
  '家具': 'furniture', '廚房': 'kitchen', '烹飪': 'kitchen',
  '寵物': 'pets', '寵物改名': 'pets',
  '送禮': 'affinity', '邀請': 'affinity', '好感度': 'affinity',
  '設施商店': 'facility',
  '稅單': 'tax',
  '捐款': 'charity', '基金會': 'charity', '拍賣': 'auction',
  '銀行': 'loans', '信用貸款': 'loans', '還款': 'loans',
  '特殊商店': 'special', '兌換': 'special',
  '行情': 'stock', '股市': 'stock', '個股': 'stock', '買股': 'stock', '賣股': 'stock',
  '持股': 'stock', '股神榜': 'stock'
};
function commandFeature(name) { return COMMAND_FEATURE[name] || null; }

module.exports.COMMAND_FEATURE = COMMAND_FEATURE;
module.exports.commandFeature = commandFeature;
