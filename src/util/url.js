// 上傳的檔案存在本機 /uploads，Discord 需要可公開存取的絕對網址
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://white.crownai.ink').replace(/\/$/, '');

/** /uploads/xxx.png → https://white.crownai.ink/uploads/xxx.png；已是完整網址則原樣回傳 */
function absUrl(u) {
  if (!u) return u;
  return String(u).startsWith('/uploads/') ? PUBLIC_URL + u : u;
}

module.exports = { absUrl, PUBLIC_URL };
