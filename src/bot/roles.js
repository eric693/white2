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

// ---- 管家專用的元件 ID 前綴 ----
// 拆成兩隻之前，遊戲面板是「舊的那一隻」（＝現在的秘書）發出去的，那些訊息會
// 一直留在頻道裡。玩家按下去時，互動送到秘書這個應用程式，但秘書根本沒載入
// 遊戲模組 —— 沒有任何 handler 回應，玩家只看到「應用程式沒有回應」，
// 而且要等 3 秒才失敗，比直接說清楚更難受。
//
// 這份清單是從 BUTLER_FEATURES 各模組的 setCustomId／startsWith 掃出來的，
// 與秘書自己的前綴完全沒有重疊，所以拿來判斷「這顆按鈕是管家的」很安全。
const BUTLER_COMPONENT_PREFIXES = new Set([
  "achall", "achback", "adv", "amount", "aqbuyone", "aqbuyqty", "aqdeposit", "aqsell",
  "aucbid", "aucbuy", "aucmodal", "bagall", "bagmove", "bagset", "bank", "chr",
  "contestme", "craftcat", "craftpick", "dexcat", "facbuy", "furnbuy", "furncash", "furncat",
  "furnplace", "furnqty", "furnsell", "furnstore", "gathermap", "giftnoop", "giftpage", "giftpanel",
  "giftpick", "giftqty", "giftwho", "hatchput", "hatchqty", "hatchsell", "hatchsellall", "homebuy",
  "homebuyok", "homecard", "homecheck", "homenav", "homeup", "kbuild", "kbuy", "kbuyok",
  "kcollect", "keat", "kgift", "ksell", "kup", "led", "loan", "pan",
  "partnerin", "partnerlog", "partnermoveout", "partnerout", "partnerpanel", "partnerwork", "petfeed", "petfood", "plantpick",
  "plantqty", "ranchbuyone", "ranchbuyqty", "ranchsell", "repairpick", "seedbuy", "seedqty", "sellall",
  "sellone", "sellpick", "sellqty", "sellqtypick", "shopgiftqty", "sqty", "sredeem", "stk",
  "strollgo", "strollpanel", "tax", "taxrules", "tg", "tgq", "trade", "tradeuser",
  "tw", "twq", "workarea", "workpick", "world"
]);

// 這個元件是不是管家的（用 ':' 前那一段比對，沒有 ':' 就整串比）
function isButlerComponent(customId) {
  const id = String(customId || '');
  if (!id) return false;
  return BUTLER_COMPONENT_PREFIXES.has(id.split(':')[0]);
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
  '世界動態': 'stock', '行情': 'stock', '股市': 'stock', '個股': 'stock', '買股': 'stock', '賣股': 'stock',
  '持股': 'stock', '股神榜': 'stock'
};
function commandFeature(name) { return COMMAND_FEATURE[name] || null; }

// ---- 元件（按鈕／下拉）→ 功能鍵對照（付費牆第二層用）----
// 為什麼不能只比對前綴：冒險面板發出去的按鈕 ID 一律長成 `adv:xxx` / `stk:xxx`，
// 跟功能模組自己的元件前綴（ranchbuyone、plantpick…）完全不同。只用前綴比對的話，
// 面板上的「牧場／農地／魚缸／股市／稅單／拍賣」全部都比不到 —— 免費方案的伺服器
// 只要開 /冒險面板 就能玩到所有付費內容。這裡改成兩張明確的表：
//   ① PANEL_FEATURE：面板 ID 的第二段（adv:ranch → ranch）
//   ② COMPONENT_PREFIX_FEATURE：功能模組自己發的元件，用 ':' 前那一段比對
// 沒列到的一律視為基本功能，不擋（寧可漏擋也不要誤擋，誤擋是玩家直接卡死）。
const PANEL_FEATURE = {
  // 採集冒險（免費方案就有，列出來是為了「這顆按鈕屬於誰」一目了然）
  fish: 'gather', mine: 'gather', wood: 'gather', forage: 'gather', hunt: 'gather', map: 'gather',
  bag: 'gather', storage: 'gather', wallet: 'gather', ledger: 'gather', sellall: 'gather',
  sellpick: 'gather', store: 'gather', recipe: 'gather', status: 'gather', craftmake: 'gather',
  forge: 'gather', repair: 'gather', quest: 'gather', questclaim: 'gather', rich: 'gather',
  checkin: 'gather',
  // 農地／牧場／魚缸
  farm: 'crops', greenhouse: 'crops', reap: 'crops', cropshop: 'crops',
  ranch: 'ranch', harvest: 'ranch', incubator: 'ranch', ranchshop: 'ranch',
  aquarium: 'aquarium', aqshop: 'aquarium', feed: 'aquarium', aqcollect: 'aquarium', aqdeposit: 'aquarium',
  // 家園線
  home: 'home', buffs: 'home', homeweb: 'home',
  kitchen: 'kitchen', furniture: 'furniture', pets: 'pets',
  love: 'affinity', gift: 'affinity', stroll: 'affinity', partner: 'partnerskills',
  dex: 'dex', titles: 'dex',
  // 金錢線
  tax: 'tax', charity: 'charity', auction: 'auction', bank: 'loans', loan: 'loans',
  trade: 'trades', shop: 'special', facility: 'facility', contest: 'contest'
};

const COMPONENT_PREFIX_FEATURE = {
  // ---- 秘書 ----
  wheel: 'wheel', wpick: 'wheel', wtag: 'wheel', wfav: 'wheel', wfavlist: 'wheel',
  wfilter: 'wheel', whist: 'wheel', wchat: 'wheel',
  poll: 'poll', giveaway: 'giveaway', ticket: 'tickets', fi: 'forum',
  m: 'music', mq: 'music', musicpick: 'music',
  bday_verify: 'birthday',
  // ---- 管家 ----
  // 股市：模組自己的元件全都是 stk:*
  stk: 'stock',
  // 各功能模組自己發的元件（取自各檔案的 setCustomId）
  seedbuy: 'crops', seedqty: 'crops', plantpick: 'crops', plantqty: 'crops',
  ranchbuyone: 'ranch', ranchbuyqty: 'ranch', ranchsell: 'ranch',
  hatchput: 'ranch', hatchqty: 'ranch', hatchsell: 'ranch', hatchsellall: 'ranch',
  aqbuyone: 'aquarium', aqbuyqty: 'aquarium', aqsell: 'aquarium', aqdeposit: 'aquarium',
  homebuy: 'home', homebuyok: 'home', homecard: 'home', homecheck: 'home', homenav: 'home', homeup: 'home',
  kbuild: 'kitchen', kbuy: 'kitchen', kbuyok: 'kitchen', kcollect: 'kitchen', keat: 'kitchen',
  kgift: 'kitchen', ksell: 'kitchen', kup: 'kitchen',
  furnbuy: 'furniture', furncash: 'furniture', furncat: 'furniture', furnplace: 'furniture',
  furnqty: 'furniture', furnsell: 'furniture', furnstore: 'furniture',
  petfeed: 'pets', petfood: 'pets',
  giftpanel: 'affinity', giftpick: 'affinity', giftqty: 'affinity', giftwho: 'affinity',
  giftpage: 'affinity', giftnoop: 'affinity', chr: 'affinity',
  strollgo: 'affinity', strollpanel: 'affinity',
  partnerin: 'partnerskills', partnerout: 'partnerskills', partnermoveout: 'partnerskills',
  partnerpanel: 'partnerskills', partnerwork: 'partnerskills',
  dexcat: 'dex', achall: 'dex', achback: 'dex',
  tax: 'tax', taxrules: 'tax',
  aucbid: 'auction', aucbuy: 'auction', aucmodal: 'auction',
  loan: 'loans', bank: 'loans',
  trade: 'trades', tradeuser: 'trades', tg: 'trades', tgq: 'trades', tw: 'trades', twq: 'trades',
  sredeem: 'special', sqty: 'special', shopgiftqty: 'special',
  facbuy: 'facility', contestme: 'contest'
};

// 這個元件屬於哪個功能鍵（沒對應就回 null ＝ 基本功能，不擋）
function componentFeature(customId) {
  const id = String(customId || '');
  if (!id) return null;
  const [head, second] = id.split(':');
  if ((head === 'adv' || head === 'stk') && second) {
    // 面板按鈕：先查面板表；stk 的其餘 ID 一律算股市
    return PANEL_FEATURE[second] || (head === 'stk' ? 'stock' : null);
  }
  return COMPONENT_PREFIX_FEATURE[head] || null;
}

module.exports.COMMAND_FEATURE = COMMAND_FEATURE;
module.exports.commandFeature = commandFeature;
module.exports.componentFeature = componentFeature;
module.exports.PANEL_FEATURE = PANEL_FEATURE;
module.exports.COMPONENT_PREFIX_FEATURE = COMPONENT_PREFIX_FEATURE;
module.exports.isButlerComponent = isButlerComponent;
module.exports.BUTLER_COMPONENT_PREFIXES = BUTLER_COMPONENT_PREFIXES;
