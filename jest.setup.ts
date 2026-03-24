/**
 * Jest global setup — runs before every test suite.
 * Sets LOG_LEVEL to silent to suppress structured logger output.
 * Tests that verify logging behavior mock console explicitly.
 */
process.env.LOG_LEVEL = "silent";
