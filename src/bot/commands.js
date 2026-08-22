// 全部 slash 指令定義（共用）。bot/index.js 進伺服器時即時註冊、scripts/register-commands.js 手動註冊都用這份。
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

const builders = [
  new SlashCommandBuilder().setName('play').setDescription('點歌並播放（歌名、SoundCloud 或 YouTube 連結）')
    .addStringOption(o => o.setName('歌曲').setDescription('歌名，或 SoundCloud 連結').setRequired(true)),
  new SlashCommandBuilder().setName('join').setDescription('（管理員）讓機器人加入語音頻道')
    .addChannelOption(o => o.setName('頻道').setDescription('指定語音頻道，不填則加入你所在的頻道')
      .addChannelTypes(ChannelType.GuildVoice)),
  new SlashCommandBuilder().setName('leave').setDescription('（管理員）讓機器人離開語音頻道'),
  new SlashCommandBuilder().setName('skip').setDescription('跳過目前歌曲'),
  new SlashCommandBuilder().setName('prev').setDescription('回到上一首歌曲'),
  new SlashCommandBuilder().setName('pause').setDescription('暫停播放（保留進度）'),
  new SlashCommandBuilder().setName('resume').setDescription('繼續播放'),
  new SlashCommandBuilder().setName('stop').setDescription('停止播放並清空播放清單'),
  new SlashCommandBuilder().setName('clear').setDescription('清空待播清單（保留目前歌曲）'),
  new SlashCommandBuilder().setName('queue').setDescription('顯示播放清單（分頁）'),
  new SlashCommandBuilder().setName('np').setDescription('顯示正在播放的歌曲與進度'),
  new SlashCommandBuilder().setName('shuffle').setDescription('隨機排列尚未播放的歌曲'),
  new SlashCommandBuilder().setName('volume').setDescription('調整播放音量')
    .addIntegerOption(o => o.setName('音量').setDescription('0～最高音量').setRequired(true)),
  new SlashCommandBuilder().setName('remove').setDescription('移除清單中的歌曲')
    .addIntegerOption(o => o.setName('順位').setDescription('要移除的排隊順位'))
    .addUserOption(o => o.setName('玩家').setDescription('移除此玩家加入的全部歌曲（管理員）')),
  new SlashCommandBuilder().setName('move').setDescription('調整歌曲在清單中的順位')
    .addIntegerOption(o => o.setName('從').setDescription('原本的順位').setRequired(true))
    .addIntegerOption(o => o.setName('到').setDescription('要移到的順位').setRequired(true)),
  new SlashCommandBuilder().setName('loop').setDescription('設定循環模式')
    .addStringOption(o => o.setName('模式').setDescription('循環方式').setRequired(true)
      .addChoices({ name: '關閉', value: 'off' }, { name: '單曲循環', value: 'track' }, { name: '整列循環', value: 'queue' })),
  new SlashCommandBuilder().setName('抽獎').setDescription('（管理員）快速建立限時抽獎')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('抽獎持續時間').setDescription('例如 30s、5m、2h（最低 1 秒、最高 24 小時）').setRequired(true))
    .addStringOption(o => o.setName('獎品名稱').setDescription('要抽出的獎品').setRequired(true))
    .addIntegerOption(o => o.setName('獎品數量').setDescription('總共會抽出的人數（預設 1）').setMinValue(1).setMaxValue(50))
    .addChannelOption(o => o.setName('抽獎頻道').setDescription('抽獎訊息發布的頻道（不填＝目前頻道）')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption(o => o.setName('人數不足流標').setDescription('參加人數少於獎品數量時，不開獎直接流標（預設否）'))
    .addRoleOption(o => o.setName('標記身分組').setDescription('發抽獎時 @ 通知這個身分組'))
    .addIntegerOption(o => o.setName('重複中獎限制').setDescription('多久內中過獎的人不再抽到（預設 12 小時）')
      .addChoices(
        { name: '不限制（都可中獎）', value: 0 },
        { name: '1 小時內不重複', value: 1 },
        { name: '3 小時內不重複', value: 3 },
        { name: '6 小時內不重複', value: 6 },
        { name: '12 小時內不重複（預設）', value: 12 },
        { name: '24 小時內不重複', value: 24 },
        { name: '72 小時內不重複', value: 72 },
        { name: '168 小時／7 天內不重複', value: 168 },
      )),
  new SlashCommandBuilder().setName('取消抽獎').setDescription('（管理員）取消進行中的抽獎（不開獎作廢）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(o => o.setName('編號').setDescription('要取消的抽獎編號（不填＝取消目前頻道進行中的抽獎）')),
  new SlashCommandBuilder().setName('警告').setDescription('（管理員）警告管理')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(s => s.setName('新增').setDescription('警告玩家（依設定自動禁言/踢除）')
      .addUserOption(o => o.setName('玩家').setDescription('要警告的玩家').setRequired(true))
      .addStringOption(o => o.setName('原因').setDescription('警告原因')))
    .addSubcommand(s => s.setName('查詢').setDescription('查看玩家的警告紀錄')
      .addUserOption(o => o.setName('玩家').setDescription('要查詢的玩家').setRequired(true)))
    .addSubcommand(s => s.setName('清除').setDescription('清除玩家的全部有效警告')
      .addUserOption(o => o.setName('玩家').setDescription('要清除的玩家').setRequired(true))),
  new SlashCommandBuilder().setName('解除禁言').setDescription('（管理員）提前解除玩家的禁言')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('玩家').setDescription('要解除禁言的玩家').setRequired(true)),
  new SlashCommandBuilder().setName('客服面板').setDescription('（管理員）發布客服單面板')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('頻道').setDescription('面板要放的頻道（不填＝目前頻道）')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder().setName('等級').setDescription('查看聊天等級與經驗值')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('排行').setDescription('聊天等級排行榜（前 10 名）'),
  new SlashCommandBuilder().setName('投票').setDescription('（管理員）建立投票')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('題目').setDescription('投票題目').setRequired(true))
    .addStringOption(o => o.setName('選項').setDescription('選項，用逗號分隔（最多 10 個）').setRequired(true))
    .addStringOption(o => o.setName('備註').setDescription('顯示在投票下方的說明（方便分辨）'))
    .addStringOption(o => o.setName('持續時間').setDescription('例如 30m、2h、1d（不填＝不自動截止）'))
    .addBooleanOption(o => o.setName('複選').setDescription('允許選多個選項'))
    .addBooleanOption(o => o.setName('匿名').setDescription('不公開投票者名單'))
    .addChannelOption(o => o.setName('頻道').setDescription('投票發布頻道（不填＝目前頻道）')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder().setName('論壇整理').setDescription('（管理員）論壇貼文整理')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('同步').setDescription('立即抓取最新論壇貼文'))
    .addSubcommand(s => s.setName('發布目錄').setDescription('在頻道發布自動更新的論壇目錄')
      .addChannelOption(o => o.setName('頻道').setDescription('目錄要放的頻道（不填＝目前頻道）')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand(s => s.setName('設定').setDescription('調整目錄呈現方式')
      .addStringOption(o => o.setName('呈現方式').setDescription('目錄怎麼列')
        .addChoices({ name: '依玩家彙總', value: 'author' }, { name: '依標籤分區', value: 'tag' }, { name: '全部貼文', value: 'none' }))
      .addStringOption(o => o.setName('排序').setDescription('排序方式')
        .addChoices({ name: '留言數', value: 'messages' }, { name: '最近活動', value: 'recent' }, { name: '最新發文', value: 'created' }))),
  // ---- 釣魚 / 挖礦掛機 ----
  new SlashCommandBuilder().setName('釣魚').setDescription('拋竿釣魚，隨機獲得不同稀有度的漁獲（有冷卻時間）'),
  new SlashCommandBuilder().setName('挖礦').setDescription('下礦坑挖礦，隨機獲得不同稀有度的礦產（有冷卻時間）'),
  new SlashCommandBuilder().setName('錢包').setDescription('查看貨幣餘額與財富排名')
    .addUserOption(o => o.setName('玩家').setDescription('要查看的玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('背包').setDescription('查看目前持有的漁獲與礦產')
    .addUserOption(o => o.setName('玩家').setDescription('要查看的玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('賣出').setDescription('把背包裡的東西賣掉換取貨幣')
    .addStringOption(o => o.setName('物品').setDescription('物品名稱、稀有度（N/R/SR/SSR）或「全部」，不填＝全部'))
    .addIntegerOption(o => o.setName('數量').setDescription('每種要賣幾個（不填＝全賣）').setMinValue(1)),
  new SlashCommandBuilder().setName('商店').setDescription('查看可購買的魚竿與鎬子'),
  new SlashCommandBuilder().setName('購買').setDescription('購買魚竿或鎬子，提升稀有掉落率')
    .addStringOption(o => o.setName('道具').setDescription('道具名稱（用 /商店 查看）').setRequired(true)),
  new SlashCommandBuilder().setName('圖鑑').setDescription('查看已收錄的漁獲／礦產圖鑑')
    .addStringOption(o => o.setName('種類').setDescription('要看哪一本')
      .addChoices({ name: '釣魚', value: 'fish' }, { name: '挖礦', value: 'mine' }))
    .addUserOption(o => o.setName('玩家').setDescription('要查看的玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('富豪榜').setDescription('查看伺服器貨幣排行榜'),
  new SlashCommandBuilder().setName('轉帳').setDescription('把星幣轉給其他玩家（可能收手續費、有每日上限）')
    .addUserOption(o => o.setName('對象').setDescription('要轉給誰').setRequired(true))
    .addIntegerOption(o => o.setName('金額').setDescription('要轉多少').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('伐木').setDescription('砍樹取得木材（有冷卻時間）'),
  new SlashCommandBuilder().setName('採集').setDescription('採集野外素材（有冷卻時間）'),
  new SlashCommandBuilder().setName('狩獵').setDescription('外出狩獵取得獵物（有冷卻時間）'),
  new SlashCommandBuilder().setName('製作').setDescription('用背包裡的材料製作物品')
    .addStringOption(o => o.setName('配方').setDescription('配方名稱（用 /配方 查看）').setRequired(true))
    .addIntegerOption(o => o.setName('次數').setDescription('要做幾次（最多 10）').setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('鍛造').setDescription('用材料鍛造裝備或道具')
    .addStringOption(o => o.setName('配方').setDescription('配方名稱（用 /配方 查看）').setRequired(true))
    .addIntegerOption(o => o.setName('次數').setDescription('要做幾次（最多 10）').setMinValue(1).setMaxValue(10)),
  new SlashCommandBuilder().setName('配方').setDescription('查看製作／鍛造的配方一覽')
    .addStringOption(o => o.setName('種類').setDescription('要看哪一類')
      .addChoices({ name: '製作', value: 'craft' }, { name: '鍛造', value: 'forge' })),
  new SlashCommandBuilder().setName('任務').setDescription('查看任務進度並領取獎勵')
    .addStringOption(o => o.setName('動作').setDescription('查看進度或領取獎勵')
      .addChoices({ name: '查看進度', value: 'list' }, { name: '領取獎勵', value: 'claim' })),
  new SlashCommandBuilder().setName('抽籤').setDescription('每日抽籤：抽星幣或幸運符（當日提升採集稀有率）'),
  new SlashCommandBuilder().setName('狀態').setDescription('查看你的冒險狀態總覽（星幣/動物/作物/工具耐久…）')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('修理').setDescription('花星幣把壞掉的工具修回滿耐久')
    .addStringOption(o => o.setName('道具').setDescription('要修理的工具名稱（用 /商店 查看）').setRequired(true)),
  new SlashCommandBuilder().setName('地圖').setDescription('查看與切換採集地圖（高級地圖次數少但稀有率高）'),
  new SlashCommandBuilder().setName('交易').setDescription('跟其他玩家以物換物（提案與成交都會公開公告）')
    .addUserOption(o => o.setName('對象').setDescription('要跟誰交易').setRequired(true))
    .addStringOption(o => o.setName('給的物品').setDescription('你要給出的物品名稱（打字會自動跳出你背包裡符合的）').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('換的物品').setDescription('你想換到的物品名稱（打字會自動跳出對方背包裡符合的）').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('給的數量').setDescription('預設 1').setMinValue(1))
    .addIntegerOption(o => o.setName('換的數量').setDescription('預設 1').setMinValue(1)),

  // ---- 經營系統：牧場養動物 ----
  new SlashCommandBuilder().setName('牧場').setDescription('查看你的牧場：養的動物與待收成的蛋/奶')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家的牧場（不填＝自己）')),
  new SlashCommandBuilder().setName('畜牧商店').setDescription('查看可購買的動物與價格'),
  new SlashCommandBuilder().setName('飼養').setDescription('購買一隻動物養進牧場空格')
    .addStringOption(o => o.setName('動物').setDescription('動物名稱（用 /畜牧商店 查看）').setRequired(true)),
  new SlashCommandBuilder().setName('收成').setDescription('收成牧場裡所有動物的蛋/奶（收進背包後可 /賣出）'),
  new SlashCommandBuilder().setName('放生').setDescription('放生某一格的動物，空出格子（不退錢）')
    .addIntegerOption(o => o.setName('格子').setDescription('要放生的格子編號（用 /牧場 查看）').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('偷').setDescription('去別人家的牧場偷未收成的產物（有每日次數與成功率）')
    .addUserOption(o => o.setName('對象').setDescription('要偷誰的牧場').setRequired(true)),
  new SlashCommandBuilder().setName('孵化').setDescription('把背包裡的蛋放進孵化室，時間到孵成動物')
    .addStringOption(o => o.setName('蛋').setDescription('要孵化的蛋名稱（用 /孵化室 查看可孵化清單）').setRequired(true)),
  new SlashCommandBuilder().setName('孵化室').setDescription('查看孵化室，領取孵好的動物到牧場'),
  // ---- 魚缸：只養 SSR 魚，每天要買飼料，會產星幣 ----
  new SlashCommandBuilder().setName('魚缸').setDescription('查看你的魚缸：SSR 魚、飼料剩餘時間與累積的星幣')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家的魚缸（不填＝自己）')),
  new SlashCommandBuilder().setName('水族商店').setDescription('查看可購買的 SSR 魚（很貴，但會每天產星幣）'),
  new SlashCommandBuilder().setName('養魚').setDescription('買一條 SSR 魚放進魚缸空格（附第一份飼料）')
    .addStringOption(o => o.setName('魚').setDescription('魚的名稱（用 /水族商店 查看）').setRequired(true)),
  new SlashCommandBuilder().setName('餵魚').setDescription('花星幣買飼料餵所有餓著的魚（沒餵會餓死）'),
  new SlashCommandBuilder().setName('撈金').setDescription('領走魚缸裡累積的星幣（沒領會被偷）'),
  new SlashCommandBuilder().setName('賣魚').setDescription('賣掉某一格的魚，回收一半價格＋缸裡未領的星幣')
    .addIntegerOption(o => o.setName('格子').setDescription('要賣的格子編號（用 /魚缸 查看）').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('偷魚').setDescription('去別人的魚缸偷未領取的星幣（有機會整條魚撈走）')
    .addUserOption(o => o.setName('對象').setDescription('要偷誰的魚缸').setRequired(true)),
  // ---- 家園系統 ----
  new SlashCommandBuilder().setName('我的家').setDescription('打開你的家園面板（房屋／廚房／家具／寵物／約會）'),
  new SlashCommandBuilder().setName('升級家園').setDescription('用金幣＋木材／礦石把房子升到下一階'),
  new SlashCommandBuilder().setName('家園加成').setDescription('查看你目前所有加成與來源明細'),
  new SlashCommandBuilder().setName('家園卡').setDescription('把你的家園畫成一張圖（房屋、寵物、稱號、加成一次看完）'),
  new SlashCommandBuilder().setName('簽到').setDescription('回小屋簽到領星幣（連續加碼，房子越大領越多）'),
  new SlashCommandBuilder().setName('家園網頁').setDescription('取得你的個人家園網頁連結（完整漂亮版）'),
  new SlashCommandBuilder().setName('家具').setDescription('買家具、擺放或收起（只有擺出來才有加成）'),
  new SlashCommandBuilder().setName('廚房').setDescription('蓋廚房、升級、做菜、領取料理'),
  new SlashCommandBuilder().setName('烹飪').setDescription('打開廚房做菜'),
  new SlashCommandBuilder().setName('寵物').setDescription('領養、餵食、查看寵物技能'),
  new SlashCommandBuilder().setName('寵物改名').setDescription('幫你的寵物取個名字')
    .addStringOption(o => o.setName('寵物').setDescription('要改名的寵物').setRequired(true))
    .addStringOption(o => o.setName('名字').setDescription('新名字').setRequired(true)),
  new SlashCommandBuilder().setName('圖鑑2').setDescription('查看各類收集完成度（收集到門檻會解鎖稱號）'),
  new SlashCommandBuilder().setName('稱號').setDescription('查看與裝備稱號（同時只能裝備 3 個）'),
  new SlashCommandBuilder().setName('送禮').setDescription('送東西給角色，提升好感度')
    .addStringOption(o => o.setName('角色').setDescription('打字搜尋角色名字').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('邀請').setDescription('邀請角色來你家作客（需要家園 Lv.6）')
    .addStringOption(o => o.setName('角色').setDescription('打字搜尋角色名字').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('好感度').setDescription('查看你跟某位角色的好感度')
    .addStringOption(o => o.setName('角色').setDescription('打字搜尋角色名字').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('設施商店').setDescription('買農地／溫室／牧場／孵化室的等級，擴充格數'),

  new SlashCommandBuilder().setName('稅單').setDescription('查看本期要繳的稅（農地稅／養殖稅／所得稅）與上期實繳')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家的稅單（不填＝自己）')),

  new SlashCommandBuilder().setName('捐款').setDescription('把星幣捐進慈善基金會（可折抵稅額，帳目全服公開）')
    .addIntegerOption(o => o.setName('金額').setDescription('要捐多少星幣').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('基金會').setDescription('查看慈善基金會的帳目、捐款榜與抵稅比例'),

  new SlashCommandBuilder().setName('貸款').setDescription('用工具／作物／魚缸的魚當抵押品借星幣（不填金額＝查額度）')
    .addIntegerOption(o => o.setName('金額').setDescription('要借多少星幣（不填＝只查可借額度與現有貸款）').setMinValue(1)),
  new SlashCommandBuilder().setName('信用貸款').setDescription('免抵押借星幣（單筆上限較低，到期沒還直接從餘額扣款）')
    .addIntegerOption(o => o.setName('金額').setDescription('要借多少星幣（不填＝查額度與說明）').setMinValue(1)),
  new SlashCommandBuilder().setName('還款').setDescription('償還物資貸款（全部還清就贖回抵押品）')
    .addIntegerOption(o => o.setName('金額').setDescription('要還多少（不填＝全部還清）').setMinValue(1)),

  new SlashCommandBuilder().setName('幫助').setDescription('冒險生活指令總表（採集/牧場/種植/交易/兌換…）'),
  new SlashCommandBuilder().setName('冒險面板').setDescription('（管理員）在目前頻道發布一鍵按鈕面板，玩家點按鈕就能玩'),

  // ---- 種植系統：農地 / 溫室 ----
  new SlashCommandBuilder().setName('種子商店').setDescription('查看可購買的種子（農地作物、溫室花卉）'),
  new SlashCommandBuilder().setName('種植').setDescription('買種子種進農地或溫室空格（可一次種多格）')
    .addStringOption(o => o.setName('種子').setDescription('種子名稱（用 /種子商店 查看）').setRequired(true))
    .addIntegerOption(o => o.setName('數量').setDescription('要種幾格（不填＝1；超過空格或餘額會自動縮減）').setMinValue(1)),
  new SlashCommandBuilder().setName('農地').setDescription('查看你的農地作物（成熟進度）')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('溫室').setDescription('查看你的溫室花卉（成熟進度）')
    .addUserOption(o => o.setName('玩家').setDescription('查看其他玩家（不填＝自己）')),
  new SlashCommandBuilder().setName('採收').setDescription('採收所有已成熟的作物（收進背包後可 /賣出）'),

  // ---- 特殊兌換商店 ----
  new SlashCommandBuilder().setName('特殊商店').setDescription('查看可用星幣兌換的特殊獎勵'),
  new SlashCommandBuilder().setName('兌換').setDescription('用星幣兌換特殊獎勵（系統會通知管理員處理）')
    .addStringOption(o => o.setName('商品').setDescription('要兌換的獎勵名稱（用 /特殊商店 查看）').setRequired(true))
    .addIntegerOption(o => o.setName('數量').setDescription('要兌換幾份（不填＝1）').setMinValue(1).setMaxValue(25)),

  // ---- 財經新聞 ＋ 星幣股市（後台預設關閉，開啟後才會有作用）----
  new SlashCommandBuilder().setName('行情').setDescription('查看目前的財經新聞行情（哪些東西賣得比較貴）'),
  new SlashCommandBuilder().setName('股市').setDescription('查看所有股票的現價與走勢'),
  new SlashCommandBuilder().setName('個股').setDescription('查看單一股票的 K 線與你的持股損益')
    .addStringOption(o => o.setName('代號').setDescription('股票代號或名稱（用 /股市 查看）').setRequired(true)),
  new SlashCommandBuilder().setName('買股').setDescription('用星幣買進股票（會收手續費）')
    .addStringOption(o => o.setName('代號').setDescription('股票代號或名稱').setRequired(true))
    .addIntegerOption(o => o.setName('股數').setDescription('要買幾股').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('賣股').setDescription('賣出持股換回星幣（會收手續費）')
    .addStringOption(o => o.setName('代號').setDescription('股票代號或名稱').setRequired(true))
    .addStringOption(o => o.setName('股數').setDescription('要賣幾股，或填「全部」').setRequired(true)),
  new SlashCommandBuilder().setName('持股').setDescription('查看我的投資組合、市值與損益'),
  new SlashCommandBuilder().setName('股神榜').setDescription('全伺服器的股票損益排行'),
];



const commands = builders.map(c => c.toJSON());

module.exports = { builders, commands };
