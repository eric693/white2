// 個人資產私密化：錢包／收支／背包／倉庫／銀行／信貸／交易／股票這些
// 只有「本人」與「管理端」看得到，其他玩家不能用任何指令或面板查。
//
// 為什麼要集中在這裡：這些查詢分散在 gather/tax/stock/loans 好幾個模組，
// 各自寫一次判斷遲早會漏掉一個入口（漏掉的那個就是資產外洩的破口）。
// 所有「想看別人資料」的地方都必須走 resolveTarget()。

// 受保護的資料類別（只影響訊息文字，判定邏輯一致）
const PRIVATE_LABEL = {
  wallet: '錢包餘額', ledger: '星幣收支明細', bag: '背包', storage: '倉庫',
  bank: '銀行存款', credit: '信貸紀錄', trade: '交易紀錄', stock: '持股與損益',
  tax: '稅單', status: '個人狀態總覽'
};

// 管理端判定：伺服器管理權限即可（跟 gather.js 既有的 isAdmin 同一條線）
function isAdmin(member) {
  return !!member && (member.permissions.has('Administrator') || member.permissions.has('ManageGuild'));
}

// 解析「要看誰的資料」。
// 回傳 { user } 代表可以看；回傳 { denied: '訊息' } 代表要擋下來。
//   ・沒指定對象 → 看自己，永遠允許
//   ・指定自己   → 允許
//   ・指定別人   → 只有管理端可以（管理端需要處理糾紛、查帳）
function resolveTarget(i, kind = 'wallet', optionName = '玩家') {
  const asked = (i.options && typeof i.options.getUser === 'function' && !i.isButton?.())
    ? i.options.getUser(optionName) : null;
  if (!asked || asked.id === i.user.id) return { user: i.user, self: true };
  if (isAdmin(i.member)) return { user: asked, self: false, asAdmin: true };
  return { denied: deniedMessage(kind) };
}

function deniedMessage(kind) {
  const what = PRIVATE_LABEL[kind] || '個人資產資料';
  return `🔒 **${what}** 是個人隱私，只有本人與管理員可以查看。\n（想看自己的話，直接不要填「玩家」這個欄位就好。）`;
}

module.exports = { isAdmin, resolveTarget, deniedMessage, PRIVATE_LABEL };
