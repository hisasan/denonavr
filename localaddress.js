'use strict';

const debug  = require('debug')('localaddress');
const os     = require('os');

// IPv4アドレスを
function ipv4toVal(address) {
  let chunk = address.split('.');
  if (chunk.length < 4) {
    return NaN;
  }
  let v = 0;
  for (let i = 0; i < 4; i++) {
    if (isNaN(chunk[i]) || chunk[i] < 0 || 255 < chunk[i]) {
      return NaN;
    }
    v = (v * 256) + chunk[i];
  }
  return v;
}

// 指定アドレスがインタフェースとダイレクトに通信可能か確認する
var isLocalAddress = function(address) {
  let ip1      = ipv4toVal(address);
  const ifaces = os.networkInterfaces();
  if (isNaN(ip1)) {
    return false;
  }

  for (let ifname in ifaces) {
    for (let i = 0; i < ifaces[ifname].length; i++) {
      let iface = ifaces[ifname][i];
      debug(iface);
      if ('IPv4' !== iface.family || iface.internal !== false) {
        continue;
      }
      let ip2   = ipv4toVal(iface.address);
      let mask  = ipv4toVal(iface.netmask);
      if (isNaN(ip2) || isNaN(mask)) {
        return false;
      }
      if ((ip1 & mask) == (ip2 & mask)) {
        return true;
      }
    }
  }
  return false;
};

module.exports = isLocalAddress;
