/**
 * zigbee2mqtt-adapter.js - Adapter to use all those zigbee devices via
 * zigbee2mqtt.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.*
 */
'use strict';

const {
	spawn,
	exec,
	execSync,
	execFile
} = require('child_process');
const https = require('https');
const os = require('os');
const fs = require('fs');
const path = require('path');

const mqtt = require('mqtt');
const {
	Adapter,
	Device,
	Property,
	Event
} = require('gateway-addon');
const Zigbee2MQTTHandler = require('./api-handler');

const Devices = require('./devices');
const ExposesDeviceGenerator = require('./ExposesDeviceGenerator');
//const colorTranslator = require('./colorTranslator');

const identity = (v) => v;


class ZigbeeMqttAdapter extends Adapter {
	constructor(addonManager, manifest) {

		//
		// STARTING THE ADDON
		//

		super(addonManager, 'ZigbeeMqttAdapter', manifest.name);
		this.config = manifest.moziot.config;

		this.current_os = os.platform().toLowerCase();



		if (typeof this.config.debug == "undefined") {
			this.config.debug = false;
		} else if (this.config.debug) {
			console.log("Debugging is enabled");
			console.log(this.config);
			console.log("OS: " + this.current_os);
		}
		addonManager.addAdapter(this);
		this.exposesDeviceGenerator = new ExposesDeviceGenerator(this, this.config);


		// Handle missing default values
		if (typeof this.config.local_zigbee2mqtt == "undefined") {
			this.config.local_zigbee2mqtt = true;
		}
		if (typeof this.config.auto_update == "undefined") {
			this.config.auto_update = true;
		}
		if (typeof this.config.prefix == "undefined") {
			this.config.prefix = "zigbee2mqtt";
		}
		if (typeof this.config.mqtt == "undefined") {
			this.config.mqtt = "mqtt://localhost";
		}

		if(this.config.local_zigbee2mqtt){
			try{
				if (typeof this.config.serial_port == "undefined" || this.config.serial_port == "") {
					console.log("Serial port is not defined in settings. Will attempt auto-detect.");
					if (this.current_os == 'linux') {
						this.config.serial_port = "/dev/ttyAMA0";
						var result = require('child_process').execSync('ls -l /dev/serial/by-id').toString();
						result = result.split(/\r?\n/);
						for (const i in result) {
							if (this.config.debug) {
								console.log("line: " + result[i]);
							}
							if (result[i].length == 3 && result[i].includes("->")) { // If there is only one USB device, grab what you can.
								this.config.serial_port = "/dev/" + result[i].split("/").pop();
							}
							// In general, be picky, and look for hints that we found a viable Zigbee stick
							if (result[i].toLowerCase().includes("cc253") || result[i].toLowerCase().includes("conbee") || result[i].toLowerCase().includes('cc26x') || result[i].toLowerCase().includes('cc265')) { // CC26X2R1, CC253, CC2652
								this.config.serial_port = "/dev/" + result[i].split("/").pop();
								console.log("- USB stick spotted at: " + this.config.serial_port);
							}
						}
					} else {
						this.config.serial_port = null; // fall back on Zigbee2MQTT's own auto-detect (which doesn't work on the Webthings Raspberry Pi disk image)
					}
				}
			}
			catch (error){
				console.log(error);
			}
		}
		
		
		this.waiting_for_map = false;
		this.waiting_for_update = false;
		this.update_result = 'idle';
		
		
		
		if(this.config.local_zigbee2mqtt == true){
			// Make sure previous instances of Zigbee2mqtt are gone
			try{
				//execSync("pgrep -f 'zigbee2mqtt-adapter/zigbee2mqtt/index.js' | xargs kill -9");
				execSync("pkill 'zigbee2mqtt-adapter/zigbee2mqtt/index.js'");
				console.log("pkill done");
			}
			catch (error){
				console.log("exec pkill error: " + error);
			}
		}

		
		
		// Start MQTT connection
		this.client = mqtt.connect(this.config.mqtt);
		this.client.on('error', (error) => console.error('mqtt error', error));
		this.client.on('message', this.handleIncomingMessage.bind(this));
		this.client.subscribe(`${this.config.prefix}/bridge/devices`);
		this.client.subscribe(`${this.config.prefix}/bridge/response/networkmap`);
		this.client.subscribe(`${this.config.prefix}/bridge/response/device/ota_update/update`);


		//this.client.subscribe(`${this.config.prefix}/#`);

		// configuration file location
		this.zigbee2mqtt_data_dir_path =
			path.join(path.resolve('../..'), '.webthings', 'data', 'zigbee2mqtt-adapter');
		if (this.config.debug) {
			console.log("this.zigbee2mqtt_data_dir_path =", this.zigbee2mqtt_data_dir_path);
		}

		// actual zigbee2mqt location
		this.zigbee2mqtt_dir_path = path.join(this.zigbee2mqtt_data_dir_path, 'zigbee2mqtt');

		// index.js file to be started by node
		this.zigbee2mqtt_file_path = path.join(this.zigbee2mqtt_dir_path, 'index.js');
		// console.log("this.zigbee2mqtt_dir_path =", this.zigbee2mqtt_dir_path);

		// should be copied at the first installation
		this.zigbee2mqtt_configuration_file_source_path =
			path.join(this.zigbee2mqtt_dir_path, 'data', 'configuration.yaml');
		this.zigbee2mqtt_configuration_file_path =
			path.join(this.zigbee2mqtt_data_dir_path, 'configuration.yaml');
		// console.log("this.zigbee2mqtt_configuration_file_path =",
		//             this.zigbee2mqtt_configuration_file_path);

		this.zigbee2mqtt_configuration_devices_file_path =
			path.join(this.zigbee2mqtt_data_dir_path, 'devices.yaml');
		this.zigbee2mqtt_configuration_groups_file_path =
			path.join(this.zigbee2mqtt_data_dir_path, 'groups.yaml');
		// console.log("this.zigbee2mqtt_configuration_devices_file_path =",
		//             this.zigbee2mqtt_configuration_devices_file_path);

		this.zigbee2mqtt_package_file_path =
			path.join(this.zigbee2mqtt_data_dir_path, 'zigbee2mqtt', 'package.json');
		// console.log("this.zigbee2mqtt_package_file_path =", this.zigbee2mqtt_package_file_path);

		this.zigbee2mqtt_configuration_log_path = path.join(this.zigbee2mqtt_data_dir_path, 'log');
		// console.log("this.zigbee2mqtt_configuration_log_path =",
		//             this.zigbee2mqtt_configuration_log_path);


		this.devices_overview = {}; //new Map(); // stores all the connected devices, and if they can be updated. Could potentially also be used to force-remove devices from the network.


		// Allow UI to connect
		try {
			this.apiHandler = new Zigbee2MQTTHandler(
				addonManager,
				this,
				this.config
			);
		} catch (error) {
			console.log("Error loading api handler: " + error)
		}


		//
		// CHECK IF ZIGBEE2MQTT SHOULD BE INSTALLED OR UPDATED
		//
		if (this.config.debug) {
			console.log("this.config.local_zigbee2mqtt = " + this.config.local_zigbee2mqtt);
		}
		if (this.config.local_zigbee2mqtt == true) {

			fs.access(this.zigbee2mqtt_dir_path, (err) => {
				if (err && err.code === 'ENOENT') {
					this.download_z2m(); // this also then starts zigbee2mqtt
				} else {
					if (this.config.debug) {
						console.log('zigbee2mqtt folder existed.');
					}

					if (this.config.auto_update) {
						console.log('Auto-update is enabled. Checking if zigbee2mqtt should be updated...');
						// downloads json from https://api.github.com/repos/Koenkk/zigbee2mqtt/releases/latest;

						try {
							const options = {
								hostname: 'api.github.com',
								port: 443,
								path: '/repos/Koenkk/zigbee2mqtt/releases/latest',
								method: 'GET',
								headers: {
									'X-Forwarded-For': 'xxx',
									'User-Agent': 'Node',
								},
							};

							const req = https.request(options, (res) => {
								if (this.config.debug) {
									console.log('statusCode:', res.statusCode);
								}
								// console.log('headers:', res.headers);

								let body = '';
								res.on('data', (chunk) => {
									body += chunk;
								});

								res.on('end', () => {
									try {

										// Parse JSON from api.github
										const github_json = JSON.parse(body);
										if (this.config.debug) {
											console.log('latest zigbee2MQTT version found on Github =', github_json.tag_name);
										}

										fs.readFile(this.zigbee2mqtt_package_file_path, 'utf8', (err, data) => {
											if (err) {
												console.log(`Error reading file from disk: ${err}`);

											} else {
												const z2m_package_json = JSON.parse(data);
												if (this.config.debug) {
													console.log(`local zigbee2MQTT version = ${z2m_package_json.version}`);
												}

												if (github_json.tag_name == z2m_package_json.version) {
													if (this.config.debug) {
														console.log('zigbee2mqtt versions are the same, no need to update zigbee2mqtt');
													}
													this.run_zigbee2mqtt();

												} else {
													console.log('a new official release of zigbee2mqtt is available.',
														'Will attempt to upgrade.');

													this.sendPairingPrompt("Updating Zigbee2MQTT to " + github_json.tag_name);

													this.delete_z2m();
													this.download_z2m(); // this also then starts zigbee2mqtt

												}
											}
										});

									} catch (error) {
										console.error(error.message);
										this.run_zigbee2mqtt();
									}
								});
							});

							req.on('error', (e) => {
								console.error(e);
								this.run_zigbee2mqtt();
							});
							req.end();
						} catch (error) {
							console.error(error.message);
							this.run_zigbee2mqtt();
						}
					} else {
						// Skipping auto-update check
						this.run_zigbee2mqtt();
					}
				}
			}); // end of fs.access check

		} else {
			console.log("Not using built-in zigbee2mqtt");
		}

	}


	// By having the config files outside of the zigbee2mqtt folder it becomes easier to update zigbee2mqtt
	check_if_config_file_exists() {
		try {
			if (this.config.debug) {
				console.log('Checking if config file exists');
			}

			fs.access(this.zigbee2mqtt_configuration_file_path, (err) => {
				if (err && err.code === 'ENOENT') {
					console.log('The configuration.yaml source file doesn\'t exist:',
						this.zigbee2mqtt_configuration_file_source_path);

					let base_config = "homeassistant: false\n" +
						"permit_join: false\n" +
						"mqtt:\n" +
						"  base_topic: zigbee2mqtt\n" +
						"  server: 'mqtt://localhost'\n" +
						"serial:\n" +
						"  port: /dev/ttyACM0\n" +
						"device_options:\n" +
						"  simulated_brightness: true\n"; +
						"    delta: 2\n"; +
						"    interval:100\n"; +
						"  legacy: false\n";

					// write to a new file named 2pac.txt
					fs.writeFile(this.zigbee2mqtt_configuration_file_path, base_config, (err) => {
						if (err) {
							console.log("Error writing base configuration.yaml file");
						} else {
							console.log('basic configuration.yaml file was succesfully created!');
						}

					});
				}

			});
		} catch (error) {
			console.error(`Error checking if zigbee2mqtt config file exists: ${error.message}`);
		}
	}



	stop_zigbee2mqtt() {
		try {
			this.zigbee2mqtt_subprocess.kill();
		} catch (error) {
			console.error(`Error stopping zigbee2mqtt: ${error.message}`);
		}
	}



	run_zigbee2mqtt() {
		this.check_if_config_file_exists();

		if (this.config.debug) {
			console.log('starting zigbee2MQTT using: node ' + this.zigbee2mqtt_file_path);
			console.log("initial this.config.serial_port = " + this.config.serial_port);
			console.log("this.zigbee2mqtt_configuration_devices_file_path = " + this.zigbee2mqtt_configuration_devices_file_path);
			console.log("this.zigbee2mqtt_configuration_log_path = " + this.zigbee2mqtt_configuration_log_path);
		}
		process.env.ZIGBEE2MQTT_DATA = this.zigbee2mqtt_data_dir_path;
		process.env.ZIGBEE2MQTT_CONFIG_MQTT_BASE_TOPIC = this.config.prefix;
		process.env.ZIGBEE2MQTT_CONFIG_MQTT_SERVER = this.config.mqtt;
		process.env.ZIGBEE2MQTT_CONFIG_SERIAL_PORT = this.config.serial_port;
		process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LEGACY_API = false;

		process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_FILE = 'Zigbee2MQTT-adapter-%TIMESTAMP%.txt';

		if (typeof this.config.ikea_test_server != "undefined") {
			process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_IKEA_OTA_USE_TEST_URL = this.config.ikea_test_server;
		}
		//process.env.ZIGBEE2MQTT_CONFIG_DEVICE_OPTIONS_SIMULATED_BRIGHTNESS = true; // doesn't seem to work

		/*
		// TODO: Change Graphviz color:
		
		# Optional: networkmap options
		map_options:
		  graphviz:
		    # Optional: Colors to be used in the graphviz network map (default: shown below)
		    colors:
		      fill:
		        enddevice: '#fff8ce'
		        coordinator: '#e04e5d'
		        router: '#4ea3e0'
		      font:
		        coordinator: '#ffffff'
		        router: '#ffffff'
		        enddevice: '#000000'
		      line:
		        active: '#009900'
		        inactive: '#994444'
		*/
		process.env.ZIGBEE2MQTT_CONFIG_MAP_OPTIONS_GRAPHVIZ_COLORS_FILL_COORDINATOR = '#333333';
		process.env.ZIGBEE2MQTT_CONFIG_MAP_OPTIONS_GRAPHVIZ_COLORS_FILL_ROUTER = '#666666';
		process.env.ZIGBEE2MQTT_CONFIG_MAP_OPTIONS_GRAPHVIZ_COLORS_FILL_ENDDEVICE = '#CCCCCC';

		process.env.ZIGBEE2MQTT_CONFIG_MAP_OPTIONS_GRAPHVIZ_COLORS_LINE_ACTIVE = '#5d9bc7';
		process.env.ZIGBEE2MQTT_CONFIG_MAP_OPTIONS_GRAPHVIZ_COLORS_LINE_INACTIVE = '#554444';
		

		if (this.config.debug) {
			process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_LEVEL = 'debug';
		} else {
			process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_LEVEL = 'error';
		}
		if (typeof this.config.channel != "undefined") {
			process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_CHANNEL = this.config.channel;
		}

		if (this.current_os == 'linux') {
			if (this.config.debug) {
				process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_DIRECTORY = this.zigbee2mqtt_configuration_log_path;
			} else {
				process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_DIRECTORY = '/tmp'; // for normal linux users the log file will be automatically deleted
			}
		} else {
			process.env.ZIGBEE2MQTT_CONFIG_ADVANCED_LOG_DIRECTORY = this.zigbee2mqtt_configuration_log_path; // Not sure where /tmp directories are on other OS-es.
		}

		//process.env.ZIGBEE2MQTT_CONFIG_DEVICES = this.zigbee2mqtt_configuration_devices_file_path;
		//process.env.ZIGBEE2MQTT_CONFIG_GROUPS = this.zigbee2mqtt_configuration_groups_file_path;
		if (this.config.debug) {
			this.zigbee2mqtt_subprocess = spawn('node', [this.zigbee2mqtt_file_path], {
				stdio: [process.stdin, process.stdout, process.stderr]
			});
		} else {
			this.zigbee2mqtt_subprocess = spawn('node', [this.zigbee2mqtt_file_path], {
				stdio: ['ignore', 'ignore', process.stderr]
			});
		}

	}



	download_z2m() {
		exec(`git clone --depth=1 https://github.com/Koenkk/zigbee2mqtt ${this.zigbee2mqtt_dir_path}`, (err, stdout, stderr) => {
			if (err) {
				console.error(err);
				return;
			}
			console.log(stdout);
			console.log("-----DOWNLOAD COMPLETE, STARTING INSTALL-----");
			exec(`cd ${this.zigbee2mqtt_dir_path}; npm ci --production`, (err, stdout, stderr) => {
				if (err) {
					console.error(err);
					return;
				}
				console.log(stdout);
				console.log("-----INSTALL COMPLETE-----");
				this.sendPairingPrompt("Ready!");
				this.run_zigbee2mqtt();
			});
		});
	}



	delete_z2m() {
		if (this.config.debug) {
			console.log('Attempting to delete local zigbee2mqtt from data folder');
		}
		try {
			execSync(`rm -rf ${this.zigbee2mqtt_dir_path}`);
			return true;
		} catch (error) {
			console.error('Error deleting:', error);
			return false;
		}
		return false;
	}



	handleIncomingMessage(topic, data) {
		if (this.config.debug) {
			console.log('');
			console.log('_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ * * *');
			console.log('in incoming message, topic: ' + topic);
			console.log(this.config.prefix);
		}
		if (topic.trim() == this.config.prefix + '/bridge/logging') {
			//console.log("ignoring logging");
			return;
		}

		if (!data.toString().includes(":")) {
			//console.log("incoming message did not have a : in it? aborting processing it.");
			return;
		}

		var msg = JSON.parse(data.toString());

		if (topic.trim() == this.config.prefix + '/bridge/devices') {
			if (this.config.debug) {
				console.log("/bridge/devices detected");
			}
			try {
				for (const device of msg) {
					this.addDevice(device);
				}
			} catch (error) {
				console.log("Error parsing /bridge/devices: " + error);
			}
		}

		// if it's not an 'internal' message, it must be a message with information about properties
		if (!topic.startsWith(this.config.prefix + '/bridge')) {
			try {
				const friendlyName = topic.replace(this.config.prefix + '/', ''); // extract the target device ID
				if (this.config.debug) {
					console.log("- friendlyName = " + friendlyName);
				}
				const device = this.getDevice(friendlyName); // try to get the device
				if (!device) {
					if (this.config.debug) {
						console.log("- strange, that device could not be found: " + friendlyName);
					}
					return;
				}
				if (msg.action && device.events.get(msg.action)) { // if there's an action (event), and the action exists in the device
					const event = new Event(
						device,
						msg.action,
						msg[device.events.get(msg.action)],
					);
					device.eventNotify(event);
				}
				for (const key of Object.keys(msg)) { // loop over actual property updates
					const property = device.findProperty(key);
					if (!property) {
						if (this.config.debug) {
							console.log("- strange, that property could not be found: " + key);
						}
						if (key != "update" && typeof msg[key] != "object") { // && key != "update_available"
							if (this.config.debug) {
								console.log("- attempting to create missing property");
							}
							this.attempt_new_property(friendlyName, key, msg[key]);
						} else {
							if (this.config.debug) {
								console.log("- ignoring update property");
							}
						}
						continue;
					}

					//console.log("updating this property:");
					//console.log(property);

					// Check if device can be updated
					if (key == 'update_available') {
						//console.log("found update_available information, storing in device_overview.");
						if(!this.waiting_for_update){
							this.devices_overview[friendlyName]['update_available'] = msg[key];
						}
						
					}

					// Attempt to make a color compatible with the gateway's HEX color system
					try {
						if (key == 'color' && typeof msg[key] == "object") {
							if (this.config.debug) {
								console.log("- translating color to hex");
							}
							var brightness = 254;
							if ('brightness' in msg) {
								brightness = msg['brightness'];
							}
							if (Object.keys(msg[key]).length == 2) {
								msg[key] = XYtoHEX(msg[key]['x'], msg[key]['y'], brightness); // turn x+y coordinates into hex color
							}
						}
					} catch (error) {
						console.log(error);
						continue;
					}

					// Modify byte to a percentage
					try {
						if (property.options.hasOwnProperty("origin")) {

							if (property.options.origin == "exposes-scaled-percentage") {
								if (this.config.debug) {
									console.log("- translating byte to percentage");
								}
								msg[key] = integer_to_percentage(msg['brightness'], property.options.origin_maximum);
							}
						}
					} catch (error) {
						console.log(error);
						continue;
					}

					// Check if an extra boolean property should be updated
					try {
						if (key == 'action') {
							//console.log("key == action");
							if (!msg.hasOwnProperty('state')) {

								if (msg[key].toLowerCase() == "on" || msg[key].toLowerCase() == "off") {
									//console.log("it's on or off");
									const extra_property = device.findProperty('power state');
									if (!extra_property) {
										//console.log("no extra power state property spotted");
									} else {
										var extra_boolean = false;
										if (msg[key].toLowerCase() == "on") {
											extra_boolean = true
										}
										const {
											extra_fromMqtt = identity
										} = extra_property.options;
										extra_property.setCachedValue(extra_fromMqtt(extra_boolean));
										device.notifyPropertyChanged(extra_property);
										if (this.config.debug) {
											console.log("extra_boolean updated");
										}
									}
								}

							}
						}
					} catch (error) {
						console.log("Error while trying to extract extra power state property: " + error);
					}

					if (this.config.debug) {
						console.log(key + " -> ");
						console.log(msg[key]);
					}
					const {
						fromMqtt = identity
					} = property.options;
					property.setCachedValue(fromMqtt(msg[key]));
					device.notifyPropertyChanged(property);
				}
			} catch (error) {
				console.log(error);
			}
		}


		// Handle incoming network map data
		if (topic.endsWith('/bridge/response/networkmap')) {
			this.apiHandler.map = msg['data']['value']; //'digraph G { "Welcome" -> "To" "To" -> "Privacy" "To" -> "ZIGBEE!"}';
			this.waiting_for_map = false;
		}
		
		
		// Handle result of firmware update
		if (topic.endsWith('/bridge/response/device/ota_update/update')) {
			if(msg['status'] == 'ok'){
				if(msg['data']['from']['software_build_id'] != msg['data']['to']['software_build_id']){
					const friendly = msg['data']['id'];
					this.devices_overview[ friendly ]['update_available'] = false;
					this.update_result = 'ok';
				}
				else{
					this.update_result = 'failed';
				}
			}
			else{
				this.update_result = 'failed';
			}
			this.waiting_for_update = false;
		}

		

	}



	publishMessage(topic, msg) {
		if (this.config.debug) {
			console.log('in pubmsg. Topic & message: ' + topic);
			console.log(msg);
		}
		this.client.publish(`${this.config.prefix}/${topic}`, JSON.stringify(msg));
	}



	addDevice(info) {
		try {
			if (this.config.debug) {
				console.log('in addDevice');
				//console.log(info);
				console.log("subscribing to: " + this.config.prefix + "/" + info.friendly_name);
			}
			this.client.subscribe(`${this.config.prefix}/${info.friendly_name}`);
			//this.client.subscribe(this.config.prefix + "/" + info.friendly_name);

			if (info.hasOwnProperty('model_id') && !this.devices_overview.hasOwnProperty(info.friendly_name)) {
				this.devices_overview[info.friendly_name] = {
					'friendly_name': info.friendly_name,
					'update_available': false,
					'model_id': info.model_id,
					'description': info.definition.description,
					'software_build_id': info.software_build_id,
					'vendor': info.definition.vendor
				};
			}

			const existingDevice = this.getDevice(info.friendly_name);
			if (existingDevice && existingDevice.modelId === info.model_id) {
				if (this.config.debug) {
					console.info(`Device ${info.friendly_name} already exists`);
				}
				return;
			}

			let deviceDefinition = Devices[info.model_id];

			if (!deviceDefinition) {
				const detectedDevice = this.exposesDeviceGenerator.generateDevice(info);
				if (detectedDevice) {
					deviceDefinition = detectedDevice;
					if (this.config.debug) {
						console.info(`Device ${info.friendly_name} created from Exposes API`);
					}
				}
			} else {
				if (this.config.debug) {
					console.info(`Device ${info.friendly_name} created from devices.js`);
				}
			}

			if (deviceDefinition) {
				//console.log("adding device to thing");
				const device = new MqttDevice(this, info.friendly_name, info.model_id, deviceDefinition);
				this.handleDeviceAdded(device);
				//console.log("handleDeviceAdded called");
			}
		} catch (error) {
			console.log("Error in addDevice: " + error);
		}

	}



	// Sometimes incoming date has values that are not reflected in existing properties. 
	// In those cases, this will attempts to add the missing properties.
	attempt_new_property(device_id, key, value) {
		if (this.config.debug) {
			console.log("in attempt_new_property for device: " + device_id + " and key: " + key);
			console.log(value);
		}

		var type = "string";
		if (Number.isFinite(value)) {
			type = "number";
		} else if (typeof value === 'boolean') {
			type = "boolean";
		}

		var desc = {
			'title': this.applySentenceCase(key),
			'description': key,
			'readOnly': true,
			'type': type
		};

		var device = this.getDevice(device_id);
		const property = new MqttProperty(device, key, desc);
		device.properties.set(key, property);
		if (this.config.debug) {
			console.log("new property should now be generated");
		}

		this.handleDeviceAdded(device);
		if (this.config.debug) {
			console.log("- handleDeviceAdded has been called again");
		}
	}



	removeDevice(deviceId) {
		if (this.config.debug) {
			console.log("Removing device: " + deviceId);
		}
		return new Promise((resolve, reject) => {
			const device = this.devices[deviceId];
			if (device) {
				this.handleDeviceRemoved(device);
				resolve(device);

				try {
					this.client.publish(`${this.config.prefix}/bridge/request/device/remove`, '{"id": "' + deviceId + '"}');
				} catch (error) {
					console.log(error);
				}


			} else {
				reject(`Device: ${deviceId} not found.`);
			}
		});
	}



	startPairing(_timeoutSeconds) {
		if (this.config.debug) {
			console.log('in startPairing');
		}

		this.client.publish(`${this.config.prefix}/bridge/request/permit_join`, '{"value": true}');

		this.client.publish(`${this.config.prefix}/bridge/config/devices/get`);
		// TODO: Set permitJoin, and cancel pairing based on a separate timer so the devices have a bit longer to pair.


		setTimeout(this.stopPairingCheck.bind(this), 130000); // pairing gets two minutes.
		//setTimeout(function(){this.stopPairingCheck();},130000); // pairing gets two minutes.
		this.last_pairing_start_time = Date.now();

	}


	stopPairingCheck() {
		if (this.last_pairing_start_time + 120000 < Date.now()) { // check if two minutes have passed since a pairing start was called
			if (this.config.debug) {
				console.log("setting permitJoin back to off");
			}
			this.client.publish(`${this.config.prefix}/bridge/request/permit_join`, '{"value": false}'); // set permitJoin back to off
		} else {
			if (this.config.debug) {
				console.log("not setting permitJoin back to off yet, something caused a time extension");
			}
		}
	}


	cancelPairing() {
		if (this.config.debug) {
			console.log('in cancelPairing (but this is not used)');
		}
		//this.client.publish(`${this.config.prefix}/bridge/request/permit_join`,'{"value": false}'); // The Webthings Gateway timeout is too quick for some Zigbee devices
	}



	unload() {
		if (this.config.debug) {
			console.log("in unload");
		}
		this.stop_zigbee2mqtt();
		console.log("zigbee2mqtt should now be stopped. Goodbye.");
		return super.unload();
	}



	applySentenceCase(title) {
		//console.log("Capitalising");
		if (title.toLowerCase() == "linkquality") {
			return "Link quality";
		}
		title = title.replace(/_/g, ' ');
		if (typeof title == "undefined") {
			title = "Unknown";
		}
		//console.log(title);
		return title.charAt(0).toUpperCase() + title.substr(1).toLowerCase();

	}

}


class MqttDevice extends Device {
	constructor(adapter, id, modelId, description) {
		super(adapter, id);
		this.name = description.name;
		this['@type'] = description['@type'];
		this.modelId = modelId;
		for (const [name, desc] of Object.entries(description.actions || {})) {
			this.addAction(name, desc);
		}
		for (const [name, desc] of Object.entries(description.properties || {})) {
			const property = new MqttProperty(this, name, desc);
			this.properties.set(name, property);
		}
		for (const [name, desc] of Object.entries(description.events || {})) {
			this.addEvent(name, desc);
		}
	}

	async performAction(action) {
		action.start();
		this.adapter.publishMessage(`${this.id}/set`, {
			[action.name]: action.input,
		});
		action.finish();
	}
}


class MqttProperty extends Property {
	constructor(device, name, propertyDescription) {
		super(device, name, propertyDescription);
		this.setCachedValue(propertyDescription.value);
		this.device.notifyPropertyChanged(this);
		this.options = propertyDescription;
	}


	setValue(value) {
		if (this.device.adapter.config.debug) {
			console.log("in setValue, where value = " + value + " and this.options: ");
			console.log(this.options);
		}

		/*
		// For now, creating extra state properties from enum that can actually be toggled is a bit complex. Sticking with read-only for now.
		if(this.options.title == "Power state"){
			console.log("updating extra Power State property");

      const property = this.device.findProperty(this.options.title);
      if (!property) {
				return;
			}
			extra_value
			if(value.toLowerCase() == 'on'){
				
			}
      const {fromMqtt = identity} = property.options;
      property.setCachedValue(fromMqtt(msg[key]));
      device.notifyPropertyChanged(property);
			return;
		}
		*/


		return new Promise((resolve, reject) => {
			super
				.setValue(value)
				.then((updatedValue) => {
					const {
						toMqtt = identity
					} = this.options;

					if (typeof this.options["type"] == "string" && this.options["title"] == "Color") { // https://github.com/EirikBirkeland/hex-to-xy
						//if(this.device.adapter.config.debug){
						//	console.log("translating HEX color to XY (cie color space)");
						//}
						//var cie_colors = HEXtoXY(updatedValue);
						//const x = cie_colors[0];
						//const y = cie_colors[1];
						//updatedValue = {"x":x, "y":y};
						updatedValue = {
							"hex": updatedValue
						};
						//{"color": {"hex": HEX}}
						if (this.device.adapter.config.debug) {
							console.log("color value set to: " + updatedValue);
						}
					}

					if (typeof this.options["origin"] == "string") {
						if (this.options["origin"] == "exposes-scaled-percentage") {
							updatedValue = percentage_to_integer(updatedValue, this.options["origin_maximum"]);
							if (this.device.adapter.config.debug) {
								console.log("- exposes-scaled-percentage -> updatedValue scaled back to: " + updatedValue);
							}
						}
					}

					this.device.adapter.publishMessage(`${this.device.id}/set`, {
						[this.name]: toMqtt(updatedValue),
					});
					resolve(updatedValue);
					this.device.notifyPropertyChanged(this);
				})
				.catch((err) => {
					reject(err);
				});
		});
	}

}


function loadAdapter(addonManager, manifest, _errorCallback) {
	new ZigbeeMqttAdapter(addonManager, manifest);
}


function integer_to_percentage(byte, maximum) {
	const factor = maximum / 100;
	const percentage = Math.floor(byte / factor);
	return percentage;
}


function percentage_to_integer(percentage, maximum) {
	const factor = maximum / 100;
	var byte = Math.floor(percentage * factor);
	if (byte > maximum) {
		console.log("percentage_to_integer overflowed");
		byte = maximum;
	}
	return byte;
}


function HEXtoXY(hex) { // thanks to https://stackoverflow.com/questions/20283401/php-how-to-convert-rgb-color-to-cie-1931-color-specification
	hex = hex.replace(/^#/, '');
	const aRgbHex = hex.match(/.{1,2}/g);
	var red = parseInt(aRgbHex[0], 16);
	var green = parseInt(aRgbHex[1], 16);
	var blue = parseInt(aRgbHex[2], 16);

	red = (red > 0.04045) ? Math.pow((red + 0.055) / (1.0 + 0.055), 2.4) : (red / 12.92);
	green = (green > 0.04045) ? Math.pow((green + 0.055) / (1.0 + 0.055), 2.4) : (green / 12.92);
	blue = (blue > 0.04045) ? Math.pow((blue + 0.055) / (1.0 + 0.055), 2.4) : (blue / 12.92);
	var X = red * 0.664511 + green * 0.154324 + blue * 0.162028;
	var Y = red * 0.283881 + green * 0.668433 + blue * 0.047685;
	var Z = red * 0.000088 + green * 0.072310 + blue * 0.986039;
	var fx = X / (X + Y + Z);
	var fy = Y / (X + Y + Z);

	return [fx.toPrecision(2), fy.toPrecision(2)];
}


function XYtoHEX(x, y, bri) { // and needs brightness too
	const z = 1.0 - x - y;
	if (x == 0) {
		x = 0.00001
	};
	if (y == 0) {
		y = 0.00001
	};
	if (bri == 0) {
		bri = 1
	};
	const Y = bri / 255.0; // Brightness of lamp
	const X = (Y / y) * x;
	const Z = (Y / y) * z;
	var r = X * 1.612 - Y * 0.203 - Z * 0.302;
	var g = -X * 0.509 + Y * 1.412 + Z * 0.066;
	var b = X * 0.026 - Y * 0.072 + Z * 0.962;

	r = r <= 0.0031308 ? 12.92 * r : (1.0 + 0.055) * Math.pow(r, (1.0 / 2.4)) - 0.055;
	g = g <= 0.0031308 ? 12.92 * g : (1.0 + 0.055) * Math.pow(g, (1.0 / 2.4)) - 0.055;
	b = b <= 0.0031308 ? 12.92 * b : (1.0 + 0.055) * Math.pow(b, (1.0 / 2.4)) - 0.055;

	const maxValue = Math.max(r, g, b);
	r /= maxValue;
	g /= maxValue;
	b /= maxValue;
	r = r * 255;
	if (r < 0) {
		r = 0
	};
	if (r > 255) {
		r = 255
	};
	g = g * 255;
	if (g < 0) {
		g = 0
	};
	if (g > 255) {
		g = 255
	};
	b = b * 255;
	if (b < 0) {
		b = 0
	};
	if (b > 255) {
		b = 255
	};

	r = Math.floor(r).toString(16);
	g = Math.floor(g).toString(16);
	b = Math.floor(b).toString(16);

	if (r.length < 2)
		r = "0" + r;
	if (g.length < 2)
		g = "0" + g;
	if (b.length < 2)
		b = "0" + b;

	return "#" + r + g + b;
}



module.exports = loadAdapter;