require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const ORDERS_FILE = path.join(__dirname, 'orders.json');

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

function buildOrderMessage(order) {
  const isCancelled = order.status === 'cancelled';
  const isAccepted = order.status === 'accepted';
  const isRejected = order.status === 'rejected';

  let color = 0x5865F2;
  let statusText = '⏳ قيد المراجعة';
  if (isAccepted) {
    color = 0x57F287;
    statusText = '✅ تم القبول';
  } else if (isRejected) {
    color = 0xED4245;
    statusText = '❌ تم الرفض';
  } else if (isCancelled) {
    color = 0xED4245;
    statusText = '🚫 ملغي — العميل خرج من السيرفر';
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`📩 طلب جديد #${order.id}`)
    .setDescription(
      `**المميزات:**\n${order.features?.length ? order.features.map(f => `• ${f}`).join('\n') : '• Standard'}\n\n**التفاصيل:**\n${order.notes || 'لا توجد تفاصيل'}`
    )
    .addFields(
      { name: '👤 العميل', value: `<@${order.userId}> (\`${order.username}\`)`, inline: true },
      { name: '📦 الباقة', value: order.plan, inline: true },
      { name: '💰 السعر', value: order.estimatedPrice || 'Custom', inline: true },
      { name: '📌 الحالة', value: statusText, inline: false }
    )
    .setTimestamp();

  const disabledAll = isCancelled || isAccepted || isRejected;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`accept_${order.id}`)
      .setLabel('قبول الطلب')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabledAll),
    new ButtonBuilder()
      .setCustomId(`reject_${order.id}`)
      .setLabel('رفض الطلب')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabledAll),
    new ButtonBuilder()
      .setCustomId(`contact_${order.id}`)
      .setLabel('التواصل مع المشتري')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isCancelled)
  );

  return { embeds: [embed], components: [row] };
}

async function pollNewOrders() {
  try {
    const channel = await client.channels.fetch(process.env.ORDERS_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const orders = readOrders();
    let changed = false;

    for (const order of orders) {
      if (!order.notifiedBot) {
        const payload = buildOrderMessage(order);
        const sentMsg = await channel.send({
          content: `@here 🔔 طلب جديد من <@${order.userId}>!`,
          ...payload,
        });
        order.notifiedBot = true;
        order.messageId = sentMsg.id;
        changed = true;
      }
    }

    if (changed) writeOrders(orders);
  } catch (err) {
    console.error('Poll Orders Error:', err.message);
  }
}

client.once('ready', () => {
  console.log(`✅ Order Bot Ready as ${client.user.tag}`);
  pollNewOrders();
  setInterval(pollNewOrders, 3000);
});

// مراقبة خروج العميل من السيرفر وإلغاء الطلب + إبلاغك + إرسال DM للعميل
client.on('guildMemberRemove', async (member) => {
  if (member.guild.id !== process.env.GUILD_ID) return;

  const orders = readOrders();
  const activeOrders = orders.filter(
    o => o.userId === member.id && (o.status === 'pending' || o.status === 'accepted')
  );

  if (!activeOrders.length) return;

  const ordersChannel = await client.channels.fetch(process.env.ORDERS_CHANNEL_ID).catch(() => null);

  for (const order of activeOrders) {
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();

    if (ordersChannel && order.messageId) {
      const msg = await ordersChannel.messages.fetch(order.messageId).catch(() => null);
      if (msg) {
        await msg.edit(buildOrderMessage(order)).catch(() => {});
      }
      await ordersChannel.send(
        `🚫 **تم إلغاء الطلب \`#${order.id}\`** لأن العميل <@${member.id}> (\`${order.username}\`) خرج من السيرفر.`
      ).catch(() => {});
    }

    try {
      await member.send(
        `⚠️ مرحباً **${order.username}**، تم **إلغاء طلبك رقم \`#${order.id}\`** تلقائياً لأنك غادرت سيرفر الطلبات. إذا كنت ترغب في إكمال الطلب، يمكنك إعادة ربط حسابك وإرسال الطلب مرة أخرى من الموقع.`
      );
    } catch {
      console.log(`Could not DM user ${member.id} (DMs may be closed).`);
    }
  }

  writeOrders(orders);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, orderId] = interaction.customId.split('_');
  const orders = readOrders();
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    return interaction.reply({ content: '⚠️ لم يتم العثور على بيانات الطلب.', ephemeral: true });
  }

  if (action === 'accept' || action === 'reject') {
    order.status = action === 'accept' ? 'accepted' : 'rejected';
    order.updatedAt = new Date().toISOString();
    order.updatedBy = interaction.user.id;
    writeOrders(orders);

    let roleAssigned = false;
    if (action === 'accept' && process.env.CLIENT_ROLE_ID && interaction.guild) {
      try {
        const member = await interaction.guild.members.fetch(order.userId).catch(() => null);
        if (member) {
          await member.roles.add(process.env.CLIENT_ROLE_ID);
          roleAssigned = true;
        }
      } catch (err) {
        console.error('Failed to assign CLIENT_ROLE_ID:', err.message);
      }
    }

    const updatedPayload = buildOrderMessage(order);
    updatedPayload.embeds[0].addFields({
      name: '🛡️ تم التحديث بواسطة',
      value: `<@${interaction.user.id}>${roleAssigned ? `\n🏷️ تم منح رتبة العميل <@&${process.env.CLIENT_ROLE_ID}>` : ''}`,
      inline: false,
    });

    await interaction.update(updatedPayload);

    try {
      const targetUser = await client.users.fetch(order.userId);
      await targetUser.send(
        action === 'accept'
          ? `✅ تم **قبول** طلبك رقم \`#${order.id}\`! سنتواصل معك قريباً لبدء التنفيذ.`
          : `❌ نعتذر، تم **رفض** طلبك رقم \`#${order.id}\` حالياً.`
      );
    } catch {}
  } else if (action === 'contact') {
    const member = await interaction.guild.members.fetch(order.userId).catch(() => null);
    if (member && process.env.CATEGORY_ID) {
      const channel = await interaction.guild.channels.create({
        name: `order-${order.id.toLowerCase()}-${member.user.username}`.slice(0, 95),
        type: ChannelType.GuildText,
        parent: process.env.CATEGORY_ID,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
        ],
      });

      await channel.send(`أهلاً <@${member.id}>! تم فتح هذه القناة بخصوص طلبك \`#${order.id}\` مع <@${interaction.user.id}>.`);
      return interaction.reply({ content: `✅ تم فتح قناة التواصل: <#${channel.id}>`, ephemeral: true });
    }

    return interaction.reply({
      content: `💬 حساب العميل: <@${order.userId}> (\`${order.username}\` | ID: \`${order.userId}\`)`,
      ephemeral: true,
    });
  }
});

client.login(process.env.BOT_TOKEN);
