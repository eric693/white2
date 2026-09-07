// /咒語簿：把自己的咒語簿連結給玩家（私訊式回覆，只有他自己看得到）。
//
// 權限在後台的「咒語簿開通」頁決定：開通名單或身分組白名單，兩者皆無就給說明訊息，
// 不直接把指令藏起來 —— 玩家至少要知道「這功能存在、要找管理員開通」。
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { PUBLIC_URL } = require('../../util/url');
const { brandColor } = require('../../util/brand');
const sb = require('../../spellbook');

function init(client) {
  client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand() || !i.guild) return;
    if (i.commandName !== '咒語簿') return;
    const gid = i.guild.id, uid = i.user.id;
    const roleIds = i.member && i.member.roles ? [...i.member.roles.cache.keys()] : [];
    const a = sb.access(gid, uid, roleIds);
    if (!a.ok) {
      return i.reply({ content: `📖 ${sb.DENY_TEXT[a.reason] || '目前無法使用咒語簿。'}`, flags: MessageFlags.Ephemeral });
    }
    const url = `${PUBLIC_URL}/spell/${require('../../routes/spell').spellToken(gid, uid)}`;
    const embed = new EmbedBuilder().setColor(brandColor()).setTitle('📖 你的咒語簿')
      .setDescription([
        '把常用的台詞分資料夾存起來，**點一下就複製**，切回這裡貼上就好。',
        '',
        '📱 **手機用法**：用 Safari／Chrome 開下面的連結 → 分享鍵 →「加入主畫面」，',
        '桌面就多一顆咒語簿圖示，跟 App 一樣。',
        '',
        '· 左上角回資料夾列表、右上角新增內容',
        '· 向右滑可以置頂常用的那幾則',
        '· 資料夾可以產生分享碼（可加密碼）分給朋友'
      ].join('\n'))
      .setFooter({ text: '這條連結是你專屬的，別人打不開（要用你的 Discord 帳號登入）' });
    return i.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('📖 打開咒語簿').setStyle(ButtonStyle.Link).setURL(url))],
      flags: MessageFlags.Ephemeral
    });
  });
  console.log('  ↳ 咒語簿模組已載入（後台開通名單控管）');
}

module.exports = { init };
