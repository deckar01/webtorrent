const arrayRemove = require('unordered-array-remove')
const debug = require('debug')('webtorrent:tcp-pool')
const net = require('net') // browser exclude

const Peer = require('./peer')

module.exports = class TCPPool {
  /**
   * TCPPool
   *
   * A "TCP pool" allows multiple swarms to listen on the same TCP port and determines
   * which swarm incoming connections are intended for by inspecting the bittorrent
   * handshake that the remote peer sends.
   *
   * @param {number} port
   */
  constructor (client) {
    debug('create tcp pool (port %s)', client.torrentPort)

    this.server = net.createServer()
    this._client = client

    // Temporarily store incoming connections so they can be destroyed if the server is
    // closed before the connection is passed off to a Torrent.
    this._pendingConns = []

    this._onConnectionBound = (conn) => this._onConnection(conn)
    this._onListening = () => this._client._onListening()
    this._onError = (err) => this._client._destroy(err)

    this.server.on('connection', this._onConnectionBound)
    this.server.on('listening', this._onListening)
    this.server.on('error', this._onError)

    this.server.listen(client.torrentPort)
  }

  /**
   * Destroy this TCP pool.
   * @param  {function} cb
   */
  destroy (cb) {
    debug('destroy tcp pool')

    this.server.removeListener('connection', this._onConnectionBound)
    this.server.removeListener('listening', this._onListening)
    this.server.removeListener('error', this._onError)

    // Destroy all open connection objects so server can close gracefully without waiting
    // for connection timeout or remote peer to disconnect.
    this._pendingConns.forEach((conn) => {
      conn.on('error', noop)
      conn.destroy()
    })

    try {
      this.server.close(cb)
    } catch (err) {
      if (cb) process.nextTick(cb)
    }

    this.server = null
    this._client = null
    this._pendingConns = null
  }

  /**
   * On incoming connections, we expect the remote peer to send a handshake first. Based
   * on the infoHash in that handshake, route the peer to the right swarm.
   */
  _onConnection (conn) {
    // If the connection has already been closed before the `connect` event is fired,
    // then `remoteAddress` will not be available, and we can't use this connection.
    // - Node.js issue: https://github.com/nodejs/node-v0.x-archive/issues/7566
    // - WebTorrent issue: https://github.com/feross/webtorrent/issues/398
    if (!conn.remoteAddress) {
      conn.on('error', noop)
      conn.destroy()
      return
    }

    this._pendingConns.push(conn)

    const peer = Peer.createTCPIncomingPeer(conn)

    const onHandshake = (infoHash, peerId) => {
      cleanupPending()
      this._onHandshake(peer, infoHash, peerId)
    }

    const cleanupPending = () => {
      conn.removeListener('close', cleanupPending)
      peer.wire.removeListener('handshake', onHandshake)
      this._cleanupPending(conn)
    }

    conn.once('close', cleanupPending)
    peer.wire.once('handshake', onHandshake)
  }

  _onHandshake (peer, infoHash, peerId) {
    const torrent = this._client.get(infoHash)
    if (torrent) {
      peer.swarm = torrent
      torrent._addIncomingPeer(peer)
      peer.onHandshake(infoHash, peerId)
    } else {
      const err = new Error(
        `Unexpected info hash ${infoHash} from incoming peer ${peer.id}`
      )
      peer.destroy(err)
    }
  }

  _cleanupPending (conn) {
    if (this._pendingConns) {
      arrayRemove(this._pendingConns, this._pendingConns.indexOf(conn))
    }
  }
}

function noop () {}
