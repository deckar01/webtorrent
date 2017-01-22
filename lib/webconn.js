const BitField = require('bitfield')
const Buffer = require('safe-buffer').Buffer
const debug = require('debug')('webtorrent:webconn')
const get = require('simple-get')
const sha1 = require('simple-sha1')
const Wire = require('bittorrent-protocol')

const VERSION = require('../package.json').version

module.exports = class WebConn extends Wire {
  /**
   * Converts requests for torrent blocks into http range requests.
   * @param {string} url web seed url
   * @param {Object} torrent
   */
  constructor (url, torrent) {
    super()

    this.url = url
    this.webPeerId = sha1.sync(url)
    this._torrent = torrent

    this._init()
  }

  _init () {
    this.setKeepAlive(true)

    this.once('handshake', (infoHash, peerId) => {
      if (this.destroyed) return
      this.handshake(infoHash, this.webPeerId)
      const numPieces = this._torrent.pieces.length
      const bitfield = new BitField(numPieces)
      for (let i = 0; i <= numPieces; i++) {
        bitfield.set(i, true)
      }
      this.bitfield(bitfield)
    })

    this.once('interested', () => {
      debug('interested')
      this.unchoke()
    })

    this.on('uninterested', () => debug('uninterested'))
    this.on('choke', () => debug('choke'))
    this.on('unchoke', () => debug('unchoke'))
    this.on('bitfield', () => debug('bitfield'))

    this.on('request', (pieceIndex, offset, length, callback) => {
      debug('request pieceIndex=%d offset=%d length=%d', pieceIndex, offset, length)
      this.httpRequest(pieceIndex, offset, length, callback)
    })
  }

  httpRequest (pieceIndex, offset, length, cb) {
    const requests = this._buildRequests(pieceIndex, offset, length)

    if (requests.length < 1) {
      return cb(new Error('Could not find file corresponding to web seed range request'))
    }

    // Now make all the HTTP requests we need in order to load this piece
    // Usually that's one requests, but sometimes it will be multiple
    // Send requests in parallel and wait for them all to come back
    const requestPromises = requests.map((request) => this._makeRequest(request))
    Promise.all(requestPromises)
    .then((buffers) => {
      if (buffers.length === 1) {
        // Common case: fetch piece in a single HTTP request, return directly
        cb(null, buffers[0])
      } else {
        // Rare case: reconstruct multiple HTTP requests across 2+ files into one
        // piece buffer
        cb(null, Buffer.concat(buffers, length))
      }
    })
    .catch(cb)
  }

  _buildRequests (pieceIndex, offset, length) {
    const pieceOffset = pieceIndex * this._torrent.pieceLength
    const rangeStart = pieceOffset + offset /* offset within whole torrent */
    const rangeEnd = rangeStart + length - 1

    // Web seed URL format:
    // For single-file torrents, make HTTP range requests directly to the web seed URL
    // For multi-file torrents, add the torrent folder and file name to the URL
    const files = this._torrent.files
    if (files.length <= 1) {
      return [{
        url: this.url,
        pieceIndex: pieceIndex,
        offset: offset,
        length: length,
        start: rangeStart,
        end: rangeEnd
      }]
    } else {
      return files
      .filter((file) => {
        return file.offset <= rangeEnd && (file.offset + file.length) > rangeStart
      })
      .map((file) => {
        const fileEnd = file.offset + file.length - 1
        const delimiter = this.url[this.url.length - 1] === '/' ? '' : '/'
        const url = this.url + delimiter + file.path
        return {
          url: url,
          pieceIndex: pieceIndex,
          offset: offset,
          length: length,
          fileOffsetInRange: Math.max(file.offset - rangeStart, 0),
          start: Math.max(rangeStart - file.offset, 0),
          end: Math.min(fileEnd, rangeEnd - file.offset)
        }
      })
    }
  }

  _makeRequest (request) {
    debug(
      'Requesting url=%s pieceIndex=%d offset=%d length=%d start=%d end=%d',
      request.url, request.pieceIndex, request.offset, request.length,
      request.start, request.end
    )

    const opts = {
      url: request.url,
      method: 'GET',
      headers: {
        'user-agent': `WebTorrent/${VERSION} (https://webtorrent.io)`,
        range: `bytes=${request.start}-${request.end}`
      }
    }

    return new Promise((resolve, reject) => {
      get.concat(opts, (err, res, data) => {
        if (err) {
          // Browsers allow HTTP redirects for simple cross-origin
          // requests but not for requests that require preflight.
          // Use a simple request to unravel any redirects and get the
          // final URL.  Retry the original request with the new URL if
          // it's different.
          //
          // This test is imperfect but it's simple and good for common
          // cases.  It catches all cross-origin cases but matches a few
          // same-origin cases too.
          const inBroswer = typeof window !== 'undefined'
          const sameOrigin = inBroswer && request.url.startsWith(window.location.origin + '/')
          if (!inBroswer || sameOrigin) {
            reject(err)
          } else {
            resolve(this._redirectRequest(opts, err))
          }
        } else {
          resolve([res, data])
        }
      })
    })
    .then(([res, data]) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return Promise.reject(new Error(`Unexpected HTTP status code ${res.statusCode}`))
      }
      debug('Got data of length %d', data.length)
      return data
    })
  }

  _redirectRequest (opts, originalError) {
    return new Promise((resolve, reject) => {
      get.head(opts.url, (errHead, res) => {
        if (errHead) {
          return reject(errHead)
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Unexpected HTTP status code ${res.statusCode}`))
        }
        if (res.url === opts.url) {
          return reject(originalError)
        }

        opts.url = res.url
        get.concat(opts, (err, res, data) => {
          if (err) {
            reject(err)
          } else {
            resolve([res, data])
          }
        })
      })
    })
  }

  destroy () {
    super.destroy()
    this._torrent = null
  }
}
