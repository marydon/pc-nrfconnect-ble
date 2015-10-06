/* Copyright (c) 2015 Nordic Semiconductor. All Rights Reserved.
 *
 * The information contained herein is property of Nordic Semiconductor ASA.
 * Terms and conditions of usage are described in detail in NORDIC
 * SEMICONDUCTOR STANDARD SOFTWARE LICENSE AGREEMENT.
 *
 * Licensees are granted free, non-transferable use of the information. NO
 * WARRANTY of ANY KIND is provided. This heading must NOT be removed from
 * the file.
 *
 */

'use strict';

import reflux from 'reflux';

import bleDriver from 'pc-ble-driver-js';
import logger from '../logging';
import textual from '../ble_driver_textual';
import remote from 'remote';
import path from 'path';

import bleDriverActions from '../actions/bleDriverActions';
import discoveryActions from '../actions/discoveryActions';
import {connectionActions} from '../actions/connectionActions';
import deviceActions from '../actions/deviceActions';
import logActions from '../actions/logActions';

import dummyAttributeData from '../utils/dummyAttributeData';

import GattDatabases from '../gattDatabases';

// No support for ecmascript6 classes in reflux
// https://github.com/reflux/refluxjs/issues/225
var bleDriverStore = reflux.createStore({

    listenables: [bleDriverActions],

    init: function(){
        this.state = {
            connectedToDriver: false,
            centralName: null,
            centralAddress: {}
        };
        this.eventCount = 0;
        this.gattDatabases = new GattDatabases.GattDatabases();
    },
    getInitialState: function() {
        return this.state;
    },
    onConnectToDriver: function(port) {
        var connectionParameters = {
            'baudRate': 115200,
            'parity': 'none',
            'flowControl': 'none',
            'logLevel': 'fatal',
            'eventInterval': 100,
            'logCallback': function(severity, message) {
                // TODO: convert from the pc-ble-driver log levels to winston logger levels
                logger.info(message);
            },
            eventCallback: this._mainEventListener.bind(this)
        };
        var self = this;
        bleDriver.open(port, connectionParameters, function(err) {
            if (err) {
                logger.error(`Error occured opening serial port. ${err}`);
                self.state.connectedToDriver = false;
                self.state.error = err;
                bleDriver.close();
            }
            else
            {
                var logFilePath = remote.getGlobal('logFileDir') + path.sep + 'log.txt';
                logger.info(`For a detailed log file see: ${logFilePath}`);
                logger.info(`Finished opening serial port ${port}.`);
                self.state.error = undefined;
                self.state.connectedToDriver = true;
                self.state.comPort = port;
                bleDriver.gap_get_address(function(gapAddress){
                    self.state.centralAddress = gapAddress;
                    logger.info('Central BLE address is: ' + gapAddress.address);
                    self.trigger(self.state);
                });

                bleDriver.gap_get_device_name(function(name){
                    self.state.centralName = name;
                    logger.info('Central name is: ' + name);
                    self.trigger(self.state);
                });
            }
            self.trigger(self.state);
        });
    },
    onDisconnectFromDriver: function() {
        bleDriver.close();
        logger.debug('Closed connection to driver');
        this.trigger({
            connectedToDriver: false,
            centralName: '',
            centralAddress: ''
        });
    },
    onGetCharacteristics: function(connectionHandle){
        // TODO: Remove current database data?
        var fullHandleRange = {
            start_handle: 1,
            end_handle: 0xffff
        };

        bleDriver.gattc_descriptor_discover(connectionHandle, fullHandleRange, function(err){
            // This function will trigger sending of BLE_GATTC_EVT_DESC_DISC_RSP events from driver
            if (err) {
                logger.error(err.message);
            } else {
                logger.debug(`Started getting all characteristics for connection with handle: ${connectionHandle}`);
            }

        });
    },
    onReadAllAttributes: function(connectionHandle) {
        var firstAttributeHandle = this.gattDatabases.getHandleList(connectionHandle)[0];
        bleDriver.gattc_read(connectionHandle, firstAttributeHandle, 0, function(err){
            if (err) {
                logger.error(`Error reading all attributes: ${err}`);
            }
        });
    },
    onWriteCommand: function(connectionHandle, handle, value) {
        console.log(`onWriteCommand: ${value}`);
    },
    onWriteRequest: function(connectionHandle, handle, value) {
        var writeOp = bleDriver.BLE_GATT_OP_WRITE_REQ;
        var flags = 0;
        var handle = handle;
        var offset = 0;
        var len = value.length;

        var writeParams = {'write_op': writeOp, 'flags': flags, 'handle': handle, 'offset': offset, 'len': len, 'value': value};

        console.log(`onWriteRequest: connectionHandle: ${connectionHandle} writeParams: ${writeParams}`);
        /*
        bleDriver.gattc_write(connectionHandle, writeParams, function(err) {
            if (err) {
                logger.error(`Error doing write request: ${err}`);
            }
        });
        */
    },
    _mainEventListener: function(eventArray){
        console.timeStamp('_mainEventListener');
        for (var i = 0; i < eventArray.length; i++) {
            this.eventCount++;
            var event = eventArray[i];

            logger.debug(new textual(event).toString());

            switch(event.id){
                case bleDriver.BLE_GAP_EVT_ADV_REPORT:
                    discoveryActions.advertisingPacketReceived(event);
                    break;
                case bleDriver.BLE_GAP_EVT_TIMEOUT:
                    switch(event.src) {
                        case bleDriver.BLE_GAP_TIMEOUT_SRC_SCAN:
                            discoveryActions.scanTimedOut(event);
                            logger.info('Scan timed out');
                            break;
                        case bleDriver.BLE_GAP_TIMEOUT_SRC_CONN:
                            connectionActions.connectTimedOut(event);
                            break;
                        default:
                            logger.info(`GAP operation timed out: ${event.src_name} (${event.src}).`);
                    }
                    break;
                case bleDriver.BLE_GAP_EVT_CONNECTED:
                    connectionActions.deviceConnected(event);
                    logger.info(`Connected to ${textual.peerAddressToTextual(event)}.`);
                    break;
                case bleDriver.BLE_GAP_EVT_DISCONNECTED:
                if (this.descriptorDiscoveryInProgress) {
                    this.descriptorDiscoveryInProgress = false;
                    this.currentConnectionHandle = -1;
                }
                    this.gattDatabases.removeGattDatabase(event.conn_handle);
                    connectionActions.deviceDisconnected(event);
                    break;
                case bleDriver.BLE_GATTC_EVT_DESC_DISC_RSP:
                    if (event.count === 0) {
                        this.onReadAllAttributes(event.conn_handle);
                    } else {
                        this.gattDatabases.onDescriptorDiscoverResponseEvent(event);
                        var handleRange = {
                            // TODO: Is it ok to assume contiguous handles here?
                            start_handle: event.descs[event.count - 1].handle + 1,
                            end_handle: 0xFFFF
                        };
                        bleDriver.gattc_descriptor_discover(event.conn_handle, handleRange, function(err){
                            if (err) {
                                logger.error(err.message);
                            }
                        });
                    }
                    break;
                case bleDriver.BLE_GATTC_EVT_READ_RSP:
                    this.gattDatabases.onReadResponse(event);
                    var attributeHandleList = this.gattDatabases.getHandleList(event.conn_handle);

                    if (event.handle >= attributeHandleList[attributeHandleList.length - 1]) {
                        var gd = this.gattDatabases.getGattDatabase(event.conn_handle);
                        connectionActions.servicesDiscovered(gd.getPrettyGattDatabase());
                    } else {
                        var nextHandle = attributeHandleList[attributeHandleList.indexOf(event.handle) + 1];
                        bleDriver.gattc_read(event.conn_handle, nextHandle, 0, function(err) {
                            if (err) {
                                logger.error(err.message);
                            }
                        });
                    }

                    break;
                case bleDriver.BLE_GATTC_EVT_HVX:
                    var gd = this.gattDatabases.getGattDatabase(event.conn_handle);

                    var attribute = this.gattDatabases.findAttribute(gd, event.handle);
                    attribute.value = event.data.toJSON().data;

                    connectionActions.servicesDiscovered(gd.getPrettyGattDatabase());
                    break;
                case bleDriver.BLE_GATTC_EVT_WRITE_RSP:
                    logger.info(`Write response event: ${event}`);
                    break;
                case bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE_REQUEST:
                {
                    connectionActions.connectionParametersUpdateRequest(event);
                    break;
                }
                case bleDriver.BLE_GAP_EVT_CONN_PARAM_UPDATE:
                {
                    connectionActions.connectionParametersUpdated(event);
                    break;
                }
                default:
                    logger.info(`Unsupported event received from SoftDevice: ${event.id} - ${event.name}`);
            }
        }
    }
});

module.exports = bleDriverStore;
