// better-sqlite3 12.x consumes this once, when its native addon initializes.
if (process.env.SQLITE_USE_URI === undefined) process.env.SQLITE_USE_URI = '1';
