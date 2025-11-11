import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function getUsage(userId, mode, period) {
  const { rows } = await pool.query(
    `SELECT bursts_used FROM voice_usage WHERE user_id=$1 AND mode=$2 AND period=$3`,
    [userId, mode, period]
  );
  return rows[0] || { bursts_used: 0 };
}

export async function incrementUsage(userId, mode, period) {
  await pool.query(
    `INSERT INTO voice_usage (user_id, period, mode, bursts_used)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (user_id, period, mode)
     DO UPDATE SET bursts_used = voice_usage.bursts_used + 1`,
    [userId, mode, period]
  );
}
