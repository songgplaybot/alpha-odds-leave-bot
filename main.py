import os
import re
import sqlite3
import asyncio
from datetime import datetime
from dotenv import load_dotenv

from telegram import (
    Update,
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    ReplyKeyboardMarkup,
)
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ChatJoinRequestHandler,
    ChatMemberHandler,
    ContextTypes,
    filters,
)
from telegram.error import TelegramError, Forbidden, RetryAfter


# =========================
# LOAD ENV
# =========================

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
CHANNEL_ID_RAW = os.getenv("CHANNEL_ID")
CHANNEL_LINK_RAW = os.getenv("CHANNEL_LINK", "")


def get_channel_id():
    if not CHANNEL_ID_RAW:
        return None

    channel_id = CHANNEL_ID_RAW.strip()

    if channel_id.startswith("-100"):
        return int(channel_id)

    if channel_id.startswith("@"):
        return channel_id

    try:
        return int(channel_id)
    except ValueError:
        return channel_id


def clean_channel_link(link):
    link = (link or "").strip()

    match = re.search(
        r"https://t\.me/\+[A-Za-z0-9_-]+|https://t\.me/[A-Za-z0-9_]+",
        link
    )

    if match:
        return match.group(0)

    return link


CHANNEL_ID = get_channel_id()
CHANNEL_LINK = clean_channel_link(CHANNEL_LINK_RAW)


# =========================
# DATABASE SETUP
# =========================

def init_db():
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            started_bot INTEGER DEFAULT 1,
            created_at TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS join_requests (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            user_chat_id INTEGER,
            status TEXT DEFAULT 'pending',
            requested_at TEXT,
            approved_at TEXT
        )
    """)

    conn.commit()
    conn.close()


def save_user(user):
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        INSERT OR REPLACE INTO users (
            user_id,
            username,
            first_name,
            last_name,
            started_bot,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """, (
        user.id,
        user.username,
        user.first_name,
        user.last_name,
        1,
        datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ))

    conn.commit()
    conn.close()


def save_join_request(user, user_chat_id):
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        INSERT OR REPLACE INTO join_requests (
            user_id,
            username,
            first_name,
            last_name,
            user_chat_id,
            status,
            requested_at,
            approved_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        user.id,
        user.username,
        user.first_name,
        user.last_name,
        user_chat_id,
        "pending",
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        None
    ))

    conn.commit()
    conn.close()


def get_pending_requests():
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            jr.user_id,
            jr.username,
            jr.first_name,
            jr.last_name,
            CASE
                WHEN u.user_id IS NOT NULL THEN 1
                ELSE 0
            END AS started_bot
        FROM join_requests jr
        LEFT JOIN users u ON jr.user_id = u.user_id
        WHERE jr.status = 'pending'
        ORDER BY jr.requested_at ASC
    """)

    rows = cursor.fetchall()

    conn.close()
    return rows


def get_started_pending_requests():
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        SELECT
            jr.user_id,
            jr.username,
            jr.first_name,
            jr.last_name
        FROM join_requests jr
        INNER JOIN users u ON jr.user_id = u.user_id
        WHERE jr.status = 'pending'
        AND u.started_bot = 1
        ORDER BY jr.requested_at ASC
    """)

    rows = cursor.fetchall()

    conn.close()
    return rows


def mark_request_approved(user_id):
    conn = sqlite3.connect("alpha_odds_bot.db")
    cursor = conn.cursor()

    cursor.execute("""
        UPDATE join_requests
        SET status = 'approved',
            approved_at = ?
        WHERE user_id = ?
    """, (
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        user_id
    ))

    conn.commit()
    conn.close()


# =========================
# HELPERS
# =========================

def is_admin(user_id):
    return user_id == ADMIN_ID


def is_already_participant_error(error):
    error_text = str(error).lower()
    return (
        "user_already_participant" in error_text
        or "user already participant" in error_text
    )


def admin_inline_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("📌 Requests", callback_data="admin_requests"),
            InlineKeyboardButton("✅ Accept Started", callback_data="admin_accept_started"),
        ],
        [
            InlineKeyboardButton("⚠️ Accept All", callback_data="admin_accept_all"),
        ],
        [
            InlineKeyboardButton("🆔 My ID", callback_data="admin_myid"),
            InlineKeyboardButton("🔄 Refresh", callback_data="admin_requests"),
        ],
    ])


def admin_reply_keyboard():
    return ReplyKeyboardMarkup(
        [
            ["📌 Requests", "✅ Accept Started"],
            ["⚠️ Accept All", "🆔 My ID"],
            ["🔄 Refresh", "🏆 Admin Panel"],
        ],
        resize_keyboard=True,
        is_persistent=True
    )


def build_requests_message():
    pending = get_pending_requests()

    if not pending:
        return (
            "📌 Pending requests: 0\n\n"
            "No pending requests saved yet."
        )

    total_pending = len(pending)
    started_count = sum(1 for row in pending if row[4] == 1)
    not_started_count = total_pending - started_count

    message = (
        f"📌 Pending requests: {total_pending}\n"
        f"✅ Started bot: {started_count}\n"
        f"⏳ Not started bot: {not_started_count}\n\n"
    )

    for row in pending[:20]:
        user_id, username, first_name, last_name, started_bot = row

        name = first_name or "Unknown"
        if last_name:
            name += f" {last_name}"

        username_text = f"@{username}" if username else "No username"
        started_text = "✅ Started bot" if started_bot else "⏳ Not started bot"

        message += f"👤 {name}\n"
        message += f"ID: {user_id}\n"
        message += f"Username: {username_text}\n"
        message += f"Status: {started_text}\n\n"

    if len(pending) > 20:
        message += f"...and {len(pending) - 20} more."

    return message


async def create_one_use_rejoin_link(context, user_id):
    invite = await context.bot.create_chat_invite_link(
        chat_id=CHANNEL_ID,
        name=f"rejoin-{user_id}",
        member_limit=1,
        creates_join_request=False
    )

    return invite.invite_link


async def approve_one_request(context, request_user_id):
    await context.bot.approve_chat_join_request(
        chat_id=CHANNEL_ID,
        user_id=request_user_id
    )

    mark_request_approved(request_user_id)


async def approve_request_rows(context, rows, title):
    approved = 0
    already_inside = 0
    failed = 0
    error_messages = []

    for row in rows:
        request_user_id = row[0]
        username = row[1]
        first_name = row[2]

        try:
            await approve_one_request(context, request_user_id)

            approved += 1
            print(f"✅ Approved: {request_user_id}")

            await asyncio.sleep(0.3)

        except RetryAfter as e:
            print(f"⏳ Rate limited. Waiting {e.retry_after} seconds...")
            await asyncio.sleep(e.retry_after)

            try:
                await approve_one_request(context, request_user_id)

                approved += 1
                print(f"✅ Approved after waiting: {request_user_id}")

            except TelegramError as retry_error:
                if is_already_participant_error(retry_error):
                    mark_request_approved(request_user_id)
                    already_inside += 1
                    print(f"ℹ️ Already inside channel, marked approved: {request_user_id}")
                else:
                    failed += 1
                    name = first_name or "Unknown"
                    username_text = f"@{username}" if username else "No username"

                    error_text = (
                        f"❌ Failed: {request_user_id} | {name} | {username_text}\n"
                        f"Reason: {retry_error}"
                    )

                    print(error_text)
                    error_messages.append(error_text)

        except TelegramError as e:
            if is_already_participant_error(e):
                mark_request_approved(request_user_id)
                already_inside += 1

                print(f"ℹ️ Already inside channel, marked approved: {request_user_id}")

                await asyncio.sleep(0.3)
                continue

            failed += 1

            name = first_name or "Unknown"
            username_text = f"@{username}" if username else "No username"

            error_text = (
                f"❌ Failed: {request_user_id} | {name} | {username_text}\n"
                f"Reason: {e}"
            )

            print(error_text)
            error_messages.append(error_text)

            await asyncio.sleep(0.3)

    final_message = (
        f"✅ {title} finished.\n\n"
        f"Approved now: {approved}\n"
        f"Already inside: {already_inside}\n"
        f"Failed: {failed}"
    )

    if error_messages:
        final_message += "\n\nFirst errors:\n"
        final_message += "\n\n".join(error_messages[:5])

    return final_message


async def setup_bot_commands(app):
    await app.bot.set_my_commands([
        BotCommand("start", "Open bot / show admin buttons"),
        BotCommand("panel", "Show admin panel"),
        BotCommand("requests", "View pending requests"),
        BotCommand("accept_started", "Approve users who started bot"),
        BotCommand("accept_all", "Approve all saved requests"),
        BotCommand("myid", "Show your Telegram ID"),
    ])


# =========================
# COMMANDS
# =========================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    save_user(user)

    if is_admin(user.id):
        await update.message.reply_text(
            "🏆 Alpha Odds Admin Panel\n\n"
            "Your admin buttons are now active under your typing box.\n\n"
            "Choose what you want to do:",
            reply_markup=admin_reply_keyboard()
        )

        await update.message.reply_text(
            "Admin quick buttons:",
            reply_markup=admin_inline_keyboard()
        )
        return

    await update.message.reply_text(
        "Welcome to Alpha Odds 🏆\n\n"
        "Your bot access has been activated successfully ✅\n\n"
        "Now we can send you a direct one-use rejoin link here if you ever leave the channel."
    )


async def panel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("❌ You are not allowed to use this command.")
        return

    await update.message.reply_text(
        "🏆 Alpha Odds Admin Panel\n\n"
        "Your buttons are active under your typing box.",
        reply_markup=admin_reply_keyboard()
    )

    await update.message.reply_text(
        "Admin quick buttons:",
        reply_markup=admin_inline_keyboard()
    )


async def myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    await update.message.reply_text(
        f"Your Telegram User ID is:\n\n{user.id}",
        reply_markup=admin_reply_keyboard() if is_admin(user.id) else None
    )


async def requests_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("❌ You are not allowed to use this command.")
        return

    await update.message.reply_text(
        build_requests_message(),
        reply_markup=admin_reply_keyboard()
    )

    await update.message.reply_text(
        "Admin quick buttons:",
        reply_markup=admin_inline_keyboard()
    )


async def accept_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("❌ You are not allowed to use this command.")
        return

    if not context.args:
        await update.message.reply_text("Use it like this:\n/accept 123456789")
        return

    try:
        request_user_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ Invalid user ID.")
        return

    try:
        await approve_one_request(context, request_user_id)

        await update.message.reply_text(
            f"✅ Approved user:\n{request_user_id}",
            reply_markup=admin_reply_keyboard()
        )

    except TelegramError as e:
        if is_already_participant_error(e):
            mark_request_approved(request_user_id)

            await update.message.reply_text(
                f"ℹ️ User is already inside the channel.\n"
                f"Marked as approved:\n{request_user_id}",
                reply_markup=admin_reply_keyboard()
            )
            return

        await update.message.reply_text(
            f"❌ Failed to approve user.\n\nError:\n{e}",
            reply_markup=admin_reply_keyboard()
        )


async def accept_all_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("❌ You are not allowed to use this command.")
        return

    pending = get_pending_requests()

    if not pending:
        await update.message.reply_text(
            "No pending requests to approve.",
            reply_markup=admin_reply_keyboard()
        )
        return

    await update.message.reply_text(
        f"⏳ Starting approval for {len(pending)} pending request(s)..."
    )

    final_message = await approve_request_rows(
        context=context,
        rows=pending,
        title="Approval"
    )

    await update.message.reply_text(
        final_message,
        reply_markup=admin_reply_keyboard()
    )


async def accept_started_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not is_admin(user.id):
        await update.message.reply_text("❌ You are not allowed to use this command.")
        return

    started_pending = get_started_pending_requests()
    all_pending = get_pending_requests()

    not_started_count = len(all_pending) - len(started_pending)

    if not started_pending:
        await update.message.reply_text(
            "No pending users have started the bot yet.\n\n"
            f"Pending users who have not started bot: {not_started_count}",
            reply_markup=admin_reply_keyboard()
        )
        return

    await update.message.reply_text(
        f"⏳ Approving {len(started_pending)} user(s) who started the bot...\n\n"
        f"Users still not started: {not_started_count}"
    )

    final_message = await approve_request_rows(
        context=context,
        rows=started_pending,
        title="Started-user approval"
    )

    final_message += f"\nStill not started bot: {not_started_count}"

    await update.message.reply_text(
        final_message,
        reply_markup=admin_reply_keyboard()
    )


# =========================
# ADMIN TEXT BUTTON HANDLER
# =========================

async def admin_text_button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user

    if not user or not is_admin(user.id):
        return

    text = update.message.text

    if text in ["📌 Requests", "🔄 Refresh"]:
        await update.message.reply_text(
            build_requests_message(),
            reply_markup=admin_reply_keyboard()
        )

    elif text == "✅ Accept Started":
        started_pending = get_started_pending_requests()
        all_pending = get_pending_requests()

        not_started_count = len(all_pending) - len(started_pending)

        if not started_pending:
            await update.message.reply_text(
                "No pending users have started the bot yet.\n\n"
                f"Pending users who have not started bot: {not_started_count}",
                reply_markup=admin_reply_keyboard()
            )
            return

        await update.message.reply_text(
            f"⏳ Approving {len(started_pending)} user(s) who started the bot...\n\n"
            f"Users still not started: {not_started_count}"
        )

        final_message = await approve_request_rows(
            context=context,
            rows=started_pending,
            title="Started-user approval"
        )

        final_message += f"\nStill not started bot: {not_started_count}"

        await update.message.reply_text(
            final_message,
            reply_markup=admin_reply_keyboard()
        )

    elif text == "⚠️ Accept All":
        pending = get_pending_requests()

        if not pending:
            await update.message.reply_text(
                "No pending requests to approve.",
                reply_markup=admin_reply_keyboard()
            )
            return

        await update.message.reply_text(
            f"⏳ Starting approval for {len(pending)} pending request(s)..."
        )

        final_message = await approve_request_rows(
            context=context,
            rows=pending,
            title="Approval"
        )

        await update.message.reply_text(
            final_message,
            reply_markup=admin_reply_keyboard()
        )

    elif text == "🆔 My ID":
        await update.message.reply_text(
            f"🆔 Your Telegram User ID is:\n\n{user.id}",
            reply_markup=admin_reply_keyboard()
        )

    elif text == "🏆 Admin Panel":
        await update.message.reply_text(
            "🏆 Alpha Odds Admin Panel\n\n"
            "Buttons are active under your typing box.",
            reply_markup=admin_reply_keyboard()
        )

        await update.message.reply_text(
            "Admin quick buttons:",
            reply_markup=admin_inline_keyboard()
        )


# =========================
# INLINE BUTTON HANDLER
# =========================

async def admin_button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user = query.from_user

    if not is_admin(user.id):
        await query.answer("You are not allowed to use this button.", show_alert=True)
        return

    await query.answer()

    data = query.data

    if data == "admin_requests":
        await query.edit_message_text(
            build_requests_message(),
            reply_markup=admin_inline_keyboard()
        )

    elif data == "admin_myid":
        await query.edit_message_text(
            f"🆔 Your Telegram User ID is:\n\n{user.id}",
            reply_markup=admin_inline_keyboard()
        )

    elif data == "admin_accept_started":
        started_pending = get_started_pending_requests()
        all_pending = get_pending_requests()

        not_started_count = len(all_pending) - len(started_pending)

        if not started_pending:
            await query.edit_message_text(
                "No pending users have started the bot yet.\n\n"
                f"Pending users who have not started bot: {not_started_count}",
                reply_markup=admin_inline_keyboard()
            )
            return

        await query.edit_message_text(
            f"⏳ Approving {len(started_pending)} user(s) who started the bot...\n\n"
            f"Users still not started: {not_started_count}"
        )

        final_message = await approve_request_rows(
            context=context,
            rows=started_pending,
            title="Started-user approval"
        )

        final_message += f"\nStill not started bot: {not_started_count}"

        await query.message.reply_text(
            final_message,
            reply_markup=admin_reply_keyboard()
        )

    elif data == "admin_accept_all":
        pending = get_pending_requests()

        if not pending:
            await query.edit_message_text(
                "No pending requests to approve.",
                reply_markup=admin_inline_keyboard()
            )
            return

        await query.edit_message_text(
            f"⏳ Starting approval for {len(pending)} pending request(s)..."
        )

        final_message = await approve_request_rows(
            context=context,
            rows=pending,
            title="Approval"
        )

        await query.message.reply_text(
            final_message,
            reply_markup=admin_reply_keyboard()
        )


# =========================
# JOIN REQUEST HANDLER
# =========================

async def handle_join_request(update: Update, context: ContextTypes.DEFAULT_TYPE):
    join_request = update.chat_join_request

    if not join_request:
        return

    user = join_request.from_user
    user_chat_id = getattr(join_request, "user_chat_id", None)

    save_join_request(user, user_chat_id)

    print("\n📌 NEW JOIN REQUEST")
    print(f"User ID: {user.id}")
    print(f"Username: @{user.username}" if user.username else "Username: None")
    print(f"Name: {user.first_name}")
    print("Saved to database.\n")

    bot_info = await context.bot.get_me()
    bot_username = bot_info.username

    keyboard = InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "Start Bot ✅",
                url=f"https://t.me/{bot_username}?start=activate"
            )
        ]
    ])

    try:
        if user_chat_id:
            await context.bot.send_message(
                chat_id=user_chat_id,
                text=(
                    "Welcome to Alpha Odds 🏆\n\n"
                    "Your request has been received.\n\n"
                    "Before we approve your request, press the button below and start the bot.\n\n"
                    "This activates your access and allows us to send you a direct one-use rejoin link "
                    "if you ever leave the channel."
                ),
                reply_markup=keyboard
            )

            print(f"✅ Start Bot message sent to join request user: {user.id}")

    except TelegramError as e:
        print(f"Could not message join request user {user.id}: {e}")


# =========================
# LEAVE DETECTOR
# =========================

async def handle_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member_update = update.chat_member

    if not member_update:
        return

    chat = member_update.chat

    if chat.id != CHANNEL_ID:
        return

    old_status = member_update.old_chat_member.status
    new_status = member_update.new_chat_member.status

    left_statuses = ["left", "kicked"]

    if old_status not in left_statuses and new_status in left_statuses:
        leaver = member_update.new_chat_member.user

        print("\n🚪 USER LEFT CHANNEL")
        print(f"User ID: {leaver.id}")
        print(f"Username: @{leaver.username}" if leaver.username else "Username: None")
        print(f"Name: {leaver.first_name}")
        print("Creating one-use direct rejoin link...\n")

        try:
            rejoin_link = await create_one_use_rejoin_link(context, leaver.id)

            print(f"✅ One-use rejoin link created: {rejoin_link}")
            print("Trying to send rejoin message...\n")

            await context.bot.send_message(
                chat_id=leaver.id,
                text=(
                    "You just left Alpha Odds 🏆\n\n"
                    "If this was a mistake, you can join back directly here:\n\n"
                    f"{rejoin_link}\n\n"
                    "This link is for one use only. We’ll be waiting for you 🔥"
                )
            )

            print("✅ Rejoin message sent with one-use direct link.\n")

        except Forbidden:
            print("❌ Could not message user. They have not started the bot or blocked it.\n")

        except TelegramError as e:
            print(f"❌ Failed to create/send one-use rejoin link: {e}\n")


# =========================
# CHANNEL ID CHECKER
# =========================

async def print_channel_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.channel_post:
        chat = update.channel_post.chat

        print("\n✅ CHANNEL FOUND")
        print(f"Channel Title: {chat.title}")
        print(f"Channel ID: {chat.id}")
        print("Copy this Channel ID into your .env file.\n")


# =========================
# MAIN BOT
# =========================

def main():
    if not BOT_TOKEN:
        print("❌ BOT_TOKEN is missing. Add it inside your .env file.")
        return

    if not ADMIN_ID:
        print("❌ ADMIN_ID is missing. Add it inside your .env file.")
        return

    if not CHANNEL_ID:
        print("❌ CHANNEL_ID is missing. Add it inside your .env file.")
        return

    init_db()

    app = (
        Application.builder()
        .token(BOT_TOKEN)
        .post_init(setup_bot_commands)
        .build()
    )

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("panel", panel_command))
    app.add_handler(CommandHandler("menu", panel_command))
    app.add_handler(CommandHandler("myid", myid))
    app.add_handler(CommandHandler("requests", requests_command))
    app.add_handler(CommandHandler("accept", accept_command))
    app.add_handler(CommandHandler("accept_all", accept_all_command))
    app.add_handler(CommandHandler("accept_started", accept_started_command))

    app.add_handler(CallbackQueryHandler(admin_button_handler))

    app.add_handler(ChatJoinRequestHandler(handle_join_request))
    app.add_handler(ChatMemberHandler(handle_member_update, ChatMemberHandler.CHAT_MEMBER))

    app.add_handler(MessageHandler(
        filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND,
        admin_text_button_handler
    ))

    # This still listens for posts inside your channel so we can check the channel ID
    app.add_handler(MessageHandler(filters.UpdateType.CHANNEL_POST, print_channel_id))

    print("✅ Alpha Odds bot is running...")
    print("📌 Commands:")
    print("/start")
    print("/panel")
    print("/menu")
    print("/myid")
    print("/requests")
    print("/accept user_id")
    print("/accept_all")
    print("/accept_started")
    print("🔗 Rejoin mode: one-use direct private invite link")

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()