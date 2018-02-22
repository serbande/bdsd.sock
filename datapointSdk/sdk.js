// Bobaos Datapoint Sdk
// collects datapoints information, provide methods to set, get, read values.
const DPTs = require('knx-dpts-baos');
const Baos = require('bobaos');
const EE = require('events').EventEmitter;

const Sdk = (params) => {
  let self = new EE();
  // simple storage for datapoint objects and descriptions
  self.store = {
    datapoints: [],
    descriptions: []
  };

  // serialport params
  let serialPortDevice = '/dev/ttyAMA0';
  let serialPortParams = {
    baudRate: 19200,
    parity: "even",
    dataBits: 8,
    stopBits: 1
  };
  if (typeof params !== 'undefined') {
    if (params.serialPort !== null && typeof params.serialPort === 'object') {
      if (params.serialPort.device !== null && typeof params.serialPort.device === 'string') {
        serialPortDevice = params.serialPort.device;
      }
      if (params.serialPort.params !== null && typeof params.serialPort.params === 'object') {
        serialPortParams = params.serialPort.params;
      }
    }
  }
  // init bobaos
  const bobaos = new Baos({serialPort: {device: serialPortDevice, params: serialPortParams}, debug: false});

  // register events

  // Datapoint class
  const Datapoint = function (props) {
    this.id = props.id;
    this.dpt = props.dpt;
    this.flags = props.flags;
    this.length = props.length;
    this.value = null;
  };
  Datapoint.prototype.getDescription = function() {
    return new Promise((resolve, reject) => {
      resolve({
        id: this.id,
        dpt: this.dpt,
        flags: this.flags,
        length: this.length
      });
    });
  };
  Datapoint.prototype.setValue = function (value) {
    return new Promise((resolve, reject) => {
      let id = this.id;
      let dpt = this.dpt;
      try {
        let encodedValue = DPTs[dpt].fromJS(value);
        bobaos.setDatapointValue(id, encodedValue)
          .then(resolve)
          .catch(reject);
      } catch (e) {
        reject(e);
      }

    });
  };
  Datapoint.prototype.getValue = function () {
    // TODO: refactor
    const processValuePayload = t => {
      return new Promise((resolve, reject) => {
        let id = t.id;
        let encodedValue = t.value;
        self.findDatapoint(id)
          .then(datapoint => {
            return datapoint
              ._applyValue(encodedValue);
          })
          .then(value => {
            resolve(value);
          })
          .catch(e => {
            reject(e)
          });
      });
    };

    let id = this.id;
    return bobaos
      .getDatapointValue(id, 1)
      .then(payload => {
        return processValuePayload(payload[0]);
      })
  };
  Datapoint.prototype.readFromBus = function () {
    return new Promise((resolve, reject) => {
      let id = this.id;
      let length = this.length;
      bobaos
        .readDatapointFromBus(id, length)
        .then(payload => {
          resolve(payload);
        })
        .catch(e => {
          reject(e);
        });
    });
  };
  // to internal use. when we got value from bus put it to store
  Datapoint.prototype._applyValue = function (value) {
    return new Promise((resolve, reject) => {
      let id = this.id;
      let dpt = this.dpt;
      try {
        this.value = DPTs[dpt].toJS(value);
        resolve(this.value);
      } catch (e) {
        reject(e);
      }
    });
  };

  // function to get datapoint object. Example: .datapoint(1).getValue();
  self.findDatapoint = id => {
    return new Promise((resolve, reject) => {
      const findDatapointById = t => t.id === id;
      let datapointIndex = self.store.datapoints.findIndex(findDatapointById);
      if (datapointIndex >= 0) {
        resolve(self.store.datapoints[datapointIndex]);
      } else {
        // cannot find datapoint with this id
        reject(new Error('cannot find datapoint with id:' + id));
      }
    });
  };

  // 1. set server item for indication to false at beginning
  // 2. get description for all datapoints [1-1000].
  // 3. send GetServerItem request for "bus connected state" item.
  // 4. enable indications
  // enable/disable indications steps are done to be
  // sure that we have all datapoint descr when got ind event
  const setIndications = function (state) {
    let value = state ? 1 : 0;
    bobaos.setServerItem(17, Buffer.alloc(1, value))
      .then(_ => {
        console.log('success on setting indications to:', value);
      })
      .catch(e => {
        console.log('error while setting indications to:', value);
      })
  };
  const getAllDatapointDescription = _ => {
    const processDatapointDescription = payload => {
      if (Array.isArray(payload)) {
        payload.forEach(t => {
          let datapoint = new Datapoint(t);
          console.log('success on get datapoint description: { id:', datapoint.id, ', dpt: ', datapoint.dpt, '}');
          self.store.datapoints.push(datapoint);
          self.store.descriptions.push(t);
        });
      }
    };
    const processError = e => {
      //console.log('error while getting datapoint description', e);
    };
    // clear store
    self.store.datapoints = [];
    self.store.descriptions = [];
    // how much datapoints at one request
    const number = 30;
    for (let i = 0, imax = 1000; i < imax; i += number) {
      if ((imax - i) > number) {
        bobaos.getDatapointDescription(i + 1, number)
          .then(processDatapointDescription)
          .catch(processError);
      } else {
        bobaos.getDatapointDescription(i + 1, imax - i)
          .then(processDatapointDescription)
          .catch(processError);
      }
    }
  };
  const getBusState = _ => {
    bobaos.getServerItem(10)
      .then(payload => {
        if (Array.isArray(payload)) {
          payload.forEach(t => {
            if (t.id === 10 && t.value.readUInt8(0) === 1) {
              console.log('got bus state: connected');
              self.emit('connected');
            }
          })
        }
      })
      .catch(e => {
        console.log('error while getting bus state', e);
      });
  };
  bobaos.on('open', _ => {
    console.log('connected to baos');
    // get all descriptions and after that get bus state
    setIndications(false);
    getAllDatapointDescription();
    setIndications(true);
    getBusState();
  });
  bobaos.on('reset', function () {
    console.log('got reset ind');
    // on reset indication. e.g. when you downloaded new config from ETS
    // get all descriptions and after that get bus state
    setIndications(false);
    getAllDatapointDescription();
    setIndications(true);
    getBusState();
  });
  // now process value indications
  bobaos.on('DatapointValue.Ind', payload => {
    const processValuePayload = function (t) {
      let id = t.id;
      let encodedValue = t.value;
      self.findDatapoint(id)
        .then(datapoint => {
          return datapoint
            ._applyValue(encodedValue)
        })
        .then(value => {
          self.emit('DatapointValue.Ind', {id: id, value: value});
        })
        .catch(e => {
          // should never be executed but anyway
          console.log('error on DatapointValue.Ind', e);
        });
    };
    if (Array.isArray(payload)) {
      payload.forEach(t => {
        processValuePayload(t);
      })
    }
  });
  return self;
};

module.exports = Sdk;