// D1 data access helpers.

export async function getOwner(db) {
  return db.prepare('SELECT * FROM owners ORDER BY created_at LIMIT 1').first();
}

export async function rateCount(db, kind, bucket, windowSeconds) {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE kind = ? AND bucket = ? AND created_at >= datetime('now', ?)`)
    .bind(kind, bucket, `-${windowSeconds} seconds`)
    .first();
  return row?.n || 0;
}

export async function rateHit(db, kind, bucket) {
  await db.prepare('INSERT INTO rate_events (id, kind, bucket) VALUES (?, ?, ?)').bind(crypto.randomUUID(), kind, bucket).run();
}

export async function senderMessageCount(db, ip, senderKey) {
  // Messages this sender already sent service-wide, for the CAPTCHA-after-2 rule.
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.direction = 'in' AND (c.sender_ip = ? OR c.sender_key = ?)`,
    )
    .bind(ip || '', senderKey || '')
    .first();
  return row?.n || 0;
}
