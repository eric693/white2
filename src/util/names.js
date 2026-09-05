// 顯示名稱：一律優先用「伺服器暱稱」。
//
// 以前各處都直接印 user.username（帳號名，例如 sweet_0722），但玩家在伺服器裡
// 用的是暱稱（例如「白白｜悲劇收藏家☆」），兩者對不起來，看板面板上就會出現
// 「這是誰？」的問題。稅單早就改用 displayName 了，其他頁面沒跟上，所以這裡
// 統一成一個工具函式。
//
// 取用順序：伺服器暱稱 → Discord 全域顯示名稱 → 帳號名。

/** 從 guild 的成員快取取顯示名稱（拿不到就退回全域顯示名／帳號名） */
function displayName(guild, user) {
  if (!user) return '';
  const m = guild && guild.members && guild.members.cache.get(user.id);
  return (m && m.displayName) || user.globalName || user.username || '';
}

/**
 * 互動情境下的顯示名稱。
 * 查自己時直接用 i.member.displayName（一定拿得到，不吃快取）；
 * 查別人才去翻成員快取。
 */
function nameOf(i, user) {
  const u = user || (i && i.user);
  if (!u) return '';
  if (i && i.user && u.id === i.user.id) {
    return (i.member && i.member.displayName) || u.globalName || u.username || '';
  }
  return displayName(i && i.guild, u);
}

module.exports = { displayName, nameOf };
