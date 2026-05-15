function formatTimestamp() {
  const now = new Date()
  return now.toISOString()
}

function log(level, message, data = {}) {
  const record = {
    timestamp: formatTimestamp(),
    level,
    message,
    ...data
  }

  const line = JSON.stringify(record)
  console.log(line)
}

function info(message, data) {
  log('INFO', message, data)
}

function error(message, data) {
  log('ERROR', message, data)
}

function warn(message, data) {
  log('WARN', message, data)
}

function debug(message, data) {
  if (process.env.DEBUG) {
    log('DEBUG', message, data)
  }
}

export { info, error, warn, debug }
