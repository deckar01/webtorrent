const arrayRemove = require('unordered-array-remove')
const debug = require('debug')('webtorrent:server')
const http = require('http')
const mime = require('mime')
const pump = require('pump')
const rangeParser = require('range-parser')
const url = require('url')

const DLNA_ORG_FLAG = '01700000000000000000000000000000'
const DLNA_HEADER = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_ORG_FLAG}`

module.exports = class Server extends http.Server {
  constructor (torrent, opts) {
    super(opts)

    this._torrent = torrent
    this._sockets = []
    this._pendingReady = []
    this._closed = false

    this.on('connection', (socket) => this.onConnection(socket))
    this.on('request', (req, res) => this.onRequest(req, res))
  }

  onRequest (req, res) {
    debug('onRequest')

    // Allow CORS requests to specify arbitrary headers, e.g. 'Range',
    // by responding to the OPTIONS preflight request with the specified
    // origin and requested headers.
    const accessControlHeaders = req.headers['access-control-request-headers']
    if (req.method === 'OPTIONS' && accessControlHeaders) {
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', accessControlHeaders)
      res.setHeader('Access-Control-Max-Age', '1728000')
      return res.end()
    }

    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
    }

    const pathname = url.parse(req.url).pathname
    if (pathname === '/favicon.ico') return res.end()

    if (this._torrent.ready) {
      this.onReady(req, res, pathname)
    } else {
      let onReady = () => {
        arrayRemove(this._pendingReady, this._pendingReady.indexOf(onReady))
        this.onReady(req, res, pathname)
      }
      this._pendingReady.push(onReady)
      this._torrent.once('ready', onReady)
    }
  }

  onReady (req, res, pathname) {
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html')
      const listHtml = this._torrent.files.map((file, i) => {
        const link = `<a download="${file.name}" href="/${i}">${file.path}</a>`
        return `<li>${link} (${file.length} bytes)</li>`
      }).join('<br>')

      const html = `<h1>${this._torrent.name}</h1><ol>${listHtml}</ol>`
      return res.end(html)
    }

    const index = Number(pathname.slice(1))
    if (Number.isNaN(index) || index >= this._torrent.files.length) {
      res.statusCode = 404
      return res.end('404 Not Found')
    }

    const file = this._torrent.files[index]

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', mime.lookup(file.name))
    res.statusCode = 200

    // Support DLNA streaming
    res.setHeader('transferMode.dlna.org', 'Streaming')
    res.setHeader('contentFeatures.dlna.org', DLNA_HEADER)

    // `rangeParser` returns an array of ranges, or an error code (number) if
    // there was an error parsing the range.
    let range = rangeParser(file.length, req.headers.range || '')

    if (Array.isArray(range)) {
      // no support for multi-range request, just use the first range
      range = range[0]

      res.statusCode = 206
      debug('range %s', JSON.stringify(range))
      res.setHeader(
        'Content-Range',
        `bytes ${range.start}-${range.end}/${file.length}`
      )
      res.setHeader('Content-Length', range.end - range.start + 1)
    } else {
      range = null
      res.setHeader('Content-Length', file.length)
    }

    if (req.method === 'HEAD') {
      return res.end()
    }

    pump(file.createReadStream(range), res)
  }

  onConnection (socket) {
    socket.setTimeout(36000000)
    this._sockets.push(socket)
    socket.once('close', () => {
      arrayRemove(this._sockets, this._sockets.indexOf(socket))
    })
  }

  destroy (cb) {
    this._sockets.forEach((socket) => socket.destroy())

    // Only call `this.close` if user has not called it already
    if (!cb) cb = () => {}
    if (this._closed) process.nextTick(cb)
    else this.close(cb)
  }

  close (cb) {
    this._closed = true
    this.removeListener('connection', this.onConnection)
    this.removeListener('request', this.onRequest)
    while (this._pendingReady.length) {
      const onReady = this._pendingReady.pop()
      this._torrent.removeListener('ready', onReady)
    }
    this._torrent = null
    super.close(cb)
  }
}
