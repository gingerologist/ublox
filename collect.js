const fs = require('fs')
const path = require('path')
const blessed = require('blessed')
const { SerialPort } = require('serialport')

let seqNum = 1
let recording = false
let lastPvtText = ''
let lastPvt = Buffer.from([])
let lastDopText = ''
let lastDop = Buffer.from([])
let string = ''

/* return 2-byte buffer */
const ubxChecksum = body => {
  let a = 0
  let b = 0
  for (let i = 0; i < body.length; i++) {
    a = (a + body[i]) % 256
    b = (b + a) % 256
  }

  return Buffer.from([a, b])
}

const parseUbxBody = (body, msg) => {
  if (body.charCodeAt(0) === 0x05 && body.charCodeAt(1) === 0x01) {
    log(`UBX_ACK_ACK, ${Buffer.from(msg, 'binary').toString('hex')}`)
  } else if (body.charCodeAt(0) === 0x05 && body.charCodeAt(1) === 0x00) {
    log(`UBX_ACK_NAK, ${Buffer.from(msg, 'binary').toString('hex')}`)
  } else {
    const hex = Buffer.from(body, 'binary').toString('hex')
    let i = 0

    const U1 = () => body.charCodeAt(i++)
    const U2 = () => U1() + U1() * 256
    const U4 = () => U2() + U2() * 256 * 256
    const X1 = U1
    const X2 = U2
    const X4 = U4
    const I2 = () => {
      const uint16 = U2()
      if (uint16 >= Math.pow(2, 15)) {
        return uint16 - Math.pow(2, 16)
      } else {
        return uint16
      }
    }
    const I4 = () => {
      const uint32 = U4()
      if (uint32 >= Math.pow(2, 31)) {
        return uint32 - Math.pow(2, 32)
      } else {
        return uint32
      }
    }

    const type = U1() // avoid `class`
    const id = U1()
    const len = U2()

    if (type === 0x01 && id === 0x04) {
      // this is dop message
      lastDop = Buffer.from(body, 'binary')
      const itow = U4()
      const gdop = U2() / 100
      const pdop = U2() / 100
      const tdop = U2() / 100
      const vdop = U2() / 100
      const hdop = U2() / 100
      const ndop = U2() / 100
      const edop = U2() / 100

      const text = `UBX-NAV-DOP, len: ${len}, ` +
        `\n\titow: ${itow}, gdop: ${gdop}, pdop: ${pdop}, ` +
        `tdop: ${tdop}, vdop: ${vdop}, hdop: ${hdop}, ` +
        `ndop: ${ndop}, edop: ${edop}`
      log(text)

      lastDopText = text

      if (recording) {
        const itowPvt = lastPvt.readUInt32LE(4)
        const itowDop = lastDop.readUInt32LE(4)
        if (itowPvt !== itowDop) {
          log('itow mismatch, skip record')
        } else {
          log('Last PVT:' + lastPvt.toString('hex'))
          log('Last DOP:' + lastDop.toString('hex'))

          const sn = Buffer.alloc(4)
          sn.writeUInt32LE(seqNum)
          log('sn :' + sn.toString('hex'))
          const segPvt = lastPvt.slice(4, 4 + 78) // length 78
          // copy flags3 to pDop
          segPvt[76] = lastPvt[4 + 78]
          segPvt[77] = lastPvt[4 + 79]
          const segDop = lastDop.slice(4 + 4)
          const bundle = Buffer.concat([sn, segPvt, segDop, sn])
          log('bundle length: ' + bundle.length + ',' + bundle.toString('hex'))

          recording.write(lastPvtText + '\n')
          recording.write(lastDopText + '\n')
          recording.write('ble: ' + bundle.toString('hex') + '\n')
          seqNum++
        }
      }
    } else if (type === 0x01 && id === 0x07) {
      // this is pvt message
      lastPvt = Buffer.from(body, 'binary')
      const validStr = x =>
        `date: ${(x & 0x01) ? 'y' : 'n'}, ` +
        `time: ${(x & 0x02) ? 'y' : 'n'}, ` +
        `fully resolved: ${(x & 0x04) ? 'y' : 'n'}, ` +
        `mag: ${(x & 0x08) ? 'y' : 'n'}, ` +
        ''
      const fixTypeStr = x => {
        switch (x) {
          case 0:
            return 'no fix'
          case 1:
            return 'dead reckoning only'
          case 2:
            return '2D-fix'
          case 3:
            return '3D-fix'
          case 4:
            return 'GNSS + dead reckoning combined'
          case 5:
            return 'time only fix'
          default:
            return 'error'
        }
      }

      const flagsStr = x =>
        `gnssFixOK:     ${(x & (1 << 0)) ? 'y' : 'n'}, ` +
        `diffSoln:      ${(x & (1 << 1)) ? 'y' : 'n'}, ` +
        `psmState:      ${((x >> 2) & 0x07)}, ` +
        `headVehValid:  ${(x & (1 << 5)) ? 'y' : 'n'}, ` +
        `carrSoln:      ${((x >> 6) & 0x03)}, ` +
        ''
      const flags2Str = x =>
        `confirmedAvai: ${(x & (1 << 5)) ? 'y' : 'n'}, ` +
        `confirmedDate: ${(x & (1 << 6)) ? 'y' : 'n'}, ` +
        `confirmedTime: ${(x & (1 << 5)) ? 'y' : 'n'}, ` +
        ''
      const lastCorrectionAge = x => {
        switch (x) {
          case 0:
            return 'Not available'
          case 1:
            return 'Age between 0 and 1 second'
          case 2:
            return 'Age between 1 (inclusive) and 2 seconds'
          case 3:
            return 'Age between 2 (inclusive) and 5 seconds'
          case 4:
            return 'Age between 5 (inclusive) and 10 seconds'
          case 5:
            return 'Age between 10 (inclusive) and 15 seconds'
          case 6:
            return 'Age between 15 (inclusive) and 20 seconds'
          case 7:
            return 'Age between 20 (inclusive) and 30 seconds'
          case 8:
            return 'Age between 30 (inclusive) and 45 seconds'
          case 9:
            return 'Age between 45 (inclusive) and 60 seconds'
          case 10:
            return 'Age between 60 (inclusive) and 90 seconds'
          case 11:
            return 'Age between 90 (inclusive) and 120 seconds'
          default:
            if (x >= 12) {
              return 'Age greater or equal than 120 seconds'
            } else {
              return 'error'
            }
        }
      }

      const flags3Str = x =>
        `invalidLlh:    ${(x & (1 << 0)) ? 'y' : 'n'}, ` +
        `lastCorrectionAge: ${lastCorrectionAge(x >> 1)}, ` +
        ''

      const itow = U4()
      const year = U2()
      const month = U1()
      const day = U1()
      const hour = U1()
      const min = U1()
      const sec = U1()
      const valid = X1()
      const tAcc = U4()
      const nano = I4()
      const fixType = U1()
      const flags = X1()
      const flags2 = X1()
      const numSV = U1()
      const lon = I4()
      const lat = I4()
      const height = I4()
      const hMSL = I4()
      const hAcc = U4()
      const vAcc = U4()
      const velN = I4()
      const velE = I4()
      const velD = I4()
      const gSpeed = I4()
      const headMot = I4()
      const sAcc = U4()
      const headAcc = U4()
      const pDop = U2()
      const flags3 = X2()
      const reserved = U4()
      const headVeh = I4()
      const magDec = I2()
      const magAcc = U2()

      const text = (`UBX-NAV-PVT, len: ${len}` +
        `\n\titow: ${itow}, ` +
        `year:  ${year}, month: ${month}, day:   ${day}, ` +
        `hour:  ${hour}, min:   ${min}, sec:   ${sec}, ` +
        `\n\tvalid:   ${validStr(valid)}` +
        `tAcc: ${tAcc}ns, nano: ${nano}ns, ` +
        `\n\tfixType: ${fixTypeStr(fixType)}, ` +
        `\n\tflags:   ${flagsStr(flags)}` +
        `\n\tflags2:  ${flags2Str(flags2)}` +
        `\n\tnumSV: ${numSV}, ` +
        `lon: ${lon / 1e7} deg, ` +
        `lat: ${lat / 1e7} deg, ` +
        `height: ${height}mm, ` +
        `hMSL: ${hMSL}mm, ` +
        `hAcc: ${hAcc}mm, ` +
        `vAcc: ${vAcc}mm, ` +
        `\n\tvelN: ${velN}mm/S, ` +
        `velE: ${velE}mm/S, ` +
        `velD: ${velD}mm/S, ` +
        `gSpeed: ${gSpeed}mm/S, ` +
        `headMot: ${headMot / 1e5} deg, ` +
        `sAcc: ${sAcc}mm/S, ` +
        `headAcc: ${headAcc / 1e5} deg, ` +
        `pDop: ${pDop / 100}` +
        `\n\tflags3: ${flags3Str(flags3)}, ` +
        `headVeh: ${headVeh / 1e5} deg, ` +
        `magDec: ${magDec / 100} deg, ` +
        `magAcc: ${magAcc / 100} deg, ` +
        `(${i} === 96)` +
        '').replace(/ +/g, ' ')
      log(text)
      lastPvtText = text
    } else if (type === 0x06 && id === 0x00) {
      const portId = U1()
      const reserved1 = U1()
      const txReady = X2()
      const mode = X4()
      const baudRate = U4()
      const inProtoMask = X2()
      const outProtoMask = X2()
      const flags = X2()
      const reserved2 = [U1(), U1()]

      const txReadyStr = x =>
        `enable:      ${(x & (1 << 0)) ? 'y' : 'n'}, ` +
        `polarity:    ${(x & (1 << 1)) ? 'high active' : 'low active'}, ` +
        `pin:         ${((x >> 2) & 0x1f)}, ` +
        `threshold:   ${((x >> 7) * 8)} bytes, ` +
        ''

      const modeStr = x =>
        `charlen:     ${((x >> 6) & 0x03) + 5} bits, ` +
        `parity:      ${((x >> 8) & 0x07)}, ` +
        `nStopBits:   ${((x >> 11) & 0x03)}, ` +
        ''

      log((`UBX-CFG-PRT, len: ${len}, ${hex}` +
        `\n\tportId: ${portId}, ` +
        `txReady: ${txReadyStr(txReady)}` +
        `mode: ${modeStr(mode)}` +
        `\n\tbaudRate: ${baudRate} bps, ` +
        `inProtoMask: ${inProtoMask}, ` +
        `outProtoMask: ${outProtoMask}, ` +
        `flags: ${flags}` +
        '').replace(/ +/g, ' '))
    } else {
      log(`UNKNOWN: ${hex}`)
    }
  }
}

/*
 * return a positive number if nmea message found
 */
const findNMEAMessage = index => {
  if (index >= string.length) return -1
  if (string.charAt(index) !== '$') return -1

  let checksum = 0
  for (let i = index + 1; i + 4 < string.length; i++) {
    if (string.charAt(i) === '*') {
      if (string.charAt(i + 3) === '\r' && string.charAt(i + 4) === '\n') {
        return i + 5 - index // length
      }
    } else {
      checksum = checksum ^ string.charAt(i)
      continue
    }
  }

  return -1
}

const findUBXMessage = index => {
  if (index + 7 >= string.length) return -1
  if (string.charCodeAt(index) !== 0xb5) return -1
  if (string.charCodeAt(index + 1) !== 0x62) return -1

  const plen = string.charCodeAt(index + 4) + 256 * string.charCodeAt(index + 5)
  if (index + plen + 7 >= string.length) return -1
  const len = 2 + 2 + 2 + plen + 2

  // const hex = Buffer.from(string.slice(index), 'binary').toString('hex')
  // log(`index: ${index}, plen: ${plen}, len: ${len}, ${hex}`)
  return len
}

const port = new SerialPort({
  path: '/dev/ttyUSB0',
  baudRate: 9600
})

port.on('error', err => {
  console.log('Port Error: ', err.message)
})

let timer = null

port.on('data', data => {
/**
  if (!timer) {
    timer = setTimeout(() => {
      if (string.length) {
        log(`discarding stale data ${string.length}`)
        if (string[0] === '$') {
          log(string)
        } else {
          log(Buffer.from(string, 'binary').toString('hex'))
        }
      }
      string = ''
      timer = null
    }, 500)
  } */

  string += data.toString('binary')

  // log(`received ${data.length} bytes, total ${string.length} bytes`)
  // log('<<<<  ' + data.toString('hex') + '  >>>> ' + data.length)

  for (;;) {
    let start
    let len = -1
    for (start = 0; start < string.length; start++) {
      len = findUBXMessage(start)
      if (len > 0) break

      len = findNMEAMessage(start)
      if (len > 0) break
    }

    if (len > 0) {
      const msg = string.slice(start, start + len)
      string = string.slice(start + len)
      if (msg.charAt(0) === '$') {
        const payload = msg.slice(1, len - 5)
        const buf = Buffer.from(payload)
        let csum = 0
        for (let i = 0; i < buf.length; i++) {
          csum = csum ^ buf[i]
        }

        const checksum = Buffer.from(msg.slice(len - 4, len - 2), 'hex')[0]

        if (checksum === csum) {
          log(payload)
        } else {
          // log(payload)
          log('bad nmea message')
        }
      } else {
        const body = msg.slice(2, msg.length - 2)
        const cka = msg.charCodeAt(msg.length - 2)
        const ckb = msg.charCodeAt(msg.length - 1)
        let a = 0
        let b = 0
        for (let i = 0; i < body.length; i++) {
          a = (a + body.charCodeAt(i)) % 256
          b = (b + a) % 256
        }

        if (a === cka && b === ckb) {
          parseUbxBody(body, msg)
        } else {
          log('bad ubx message: ')
          let m = msg
          while (m.length > 0) {
            log('  ' + Buffer.from(m.slice(0, 16), 'binary').toString('hex'))
            m = m.slice(16)
          }
        }
      }
    } else {
      return
    }
  }
})

const screen = blessed.screen({
  smartCSR: true
})

const body = blessed.box({
  top: 0,
  left: 0,
  height: '100%-1',
  width: '100%',
  keys: false,
  mouse: true,
  alwaysScroll: true,
  scrollable: true,
  scrollbar: { ch: ' ', bg: 'red', inverse: true }
})

const log = text => {
  const scroll = (body.getScrollPerc() === 100)
  body.pushLine(text)
  if (scroll) {
    body.setScrollPerc(100)
  }
  screen.render()
}

const inputBar = blessed.textbox({
  bottom: 0,
  left: 0,
  height: 1,
  width: '100%',
  keys: true,
  mouse: true,
  inputOnFocus: true,
  style: {
    fg: 'white',
    bg: 'blue' // Blue background so you see this is different from body
  }
})

screen.append(body)
screen.append(inputBar)
screen.key('enter', (ch, key) => { inputBar.focus() })

const head = Buffer.from([0xb5, 0x62])

inputBar.on('submit', text => {
  if (text === 'help') {
    log(
      'usage:' +
      '\n\tdm - disable mouse (so you can select text on screen)' +
      '\n\tem - enable mouse (so you can scroll screen with mouse wheel)' +
      '\n\tport - polls the configuration for uart port (UBX-CFG-PRT)' +
      '\n\toutput none - disable output on uart port (UBX-CFG-PRT)' +
      '\n\toutput ubx - enable ubx output on uart port (UBX-CFG-PRT)' +
      '\n\tenable pvt - (re)enable UBX-NAV-PVT message (UBX-CFG-MSG)' +
      '\n\tenable dop - (re)enable UBX-NAV-DOP message (UBX-CFG-MSG)' +
      '\n\tenable pvtdop - (re)enable both messages in single uart write' +
      '')
  } else if (text === 'exit' || text === ':q') {
    process.exit(0)
  } else if (text === 'dm') {
    screen.program.disableMouse()
  } else if (text === 'em') {
    screen.program.enableMouse()
  } else if (text === 'port') { // (text.startsWith('UBX-CFG-PRT')) {
    const head = Buffer.from([0xb5, 0x62])
    const body = Buffer.from([0x06, 0x00, 0x01, 0x00, 0x01])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, err => {
      if (err) {
        log(err.message)
      } else {
        log('UBX-CFG-PRT sent')
        log(msg.toString('hex'))
      }
    })
  } else if (text === 'nmea') {
    let body, tail, msg
    // GGA 0xf0 0x00
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x00, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})

    // GLL 0xf0 0x01
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x01, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})

    // GSA 0xf0 0x02
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x02, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})

    // GSV 0xf0 0x03
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x03, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})

    // RMC 0xf0 0x04
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x04, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})

    // VTG 0xf0 0x05
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0xf0, 0x05, 0, 0, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})
  } else if (text === 'output none') {
    // 0600 1400 01000000 c0080000 80250000, 0700, 0300, 00000000
    const body = Buffer.from([0x06, 0x00, 0x14, 0x00,
      0x01, // port id
      0x00, // res
      0x00, 0x00, // txReady
      0xc0, 0x08, 0x00, 0x00, // mode
      0x80, 0x25, 0x00, 0x00, // baud
      0x07, 0x00, // inproto
      0x00, 0x00, // outproto
      0x00, 0x00, // flags
      0x00, 0x00])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {
      log(`UBX-CFG-PRT sent, ${msg.toString('hex')}`)
    })
  } else if (text === 'output ubx') {
    // 0600 1400 01000000 c0080000 80250000, 0700, 0300, 00000000
    const body = Buffer.from([0x06, 0x00, 0x14, 0x00,
      0x01, // port id
      0x00, // res
      0x00, 0x00, // txReady
      0xc0, 0x08, 0x00, 0x00, // mode
      0x80, 0x25, 0x00, 0x00, // baud
      0x07, 0x00, // inproto
      0x01, 0x00, // outproto, set to ubx only
      0x00, 0x00, // flags
      0x00, 0x00])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {
      log(`UBX-CFG-PRT sent, ${msg.toString('hex')}`)
    })
  } else if (text === 'enable pvt') {
    const body = Buffer.from([0x06, 0x01, // UBX-CFG-MSG
      0x08, 0x00, 0x01, 0x07, 0, 10, 0, 0, 0, 0])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, () => log(`UBX-CFG-MSG sent, ${msg.toString('hex')}`))
  } else if (text === 'enable dop') {
    const body = Buffer.from([0x06, 0x01, // UBX-CFG-MSG
      0x08, 0x00, 0x01, 0x04, 0, 10, 0, 0, 0, 0])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, () => log(`UBX-CFG-MSG sent, ${msg.toString('hex')}`))
  } else if (text === 'enable pvtdop') {
    let body, tail, msg
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0x01, 0x07, 0, 10, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([head, body, tail])
    body = Buffer.from([0x06, 0x01, 0x08, 0x00, 0x01, 0x04, 0, 10, 0, 0, 0, 0])
    tail = ubxChecksum(body)
    msg = Buffer.concat([msg, Buffer.concat([head, body, tail])])
    port.write(msg, () => log(`UBX-CFG-MSG sent, ${msg.toString('hex')}`))
  } else if (text === 'pms') {
    // let body, tail, msg
    const body = Buffer.from([0x06, 0x86, 0x08, 0x00,
      0x00, /* version */
      0x05, /* Aggressive with 1Hz */
      0, 0, /* n/a */
      0, 0, /* n/a */
      0, 0 /* reserved */
    ])
    const tail = ubxChecksum(body)
    const msg = Buffer.concat([head, body, tail])
    port.write(msg, () => {})
  } else if (text === 'record on') {
    if (recording) {
      log('recording is already started')
    } else {
      recording = fs.createWriteStream('log.txt')
      log('recording started')
    }
  } else if (text === 'record off') {
    if (recording) {
      recording.close()
      recording = null
      log('recording stopped')
    } else {
      log('not recording')
    }
  }

  inputBar.clearValue()
  screen.render()
  inputBar.focus()
})

inputBar.focus()
