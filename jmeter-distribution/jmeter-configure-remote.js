require('dotenv').config(); // Load .env file
const { exec } = require('child_process');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

// Configuration Details from .env file
const masterIp = process.env.MASTER_IP;
const slaveIps = process.env.SLAVE_IPS.split(',');
const jmeterDir = process.env.JMETER_DIR;
// const serverPort = parseInt(process.env.SERVER_PORT);
const threadDistribution = process.env.THREAD_DISTRIBUTION.split(',').map(num => parseInt(num));
const jmeterVersion = process.env.JMETER_VERSION;
const testPlanPath = process.env.TEST_PLAN_PATH; // Absolute path to .jmx file
const resultPath = process.env.RESULT_PATH; // Absolute path to result .jtl file

// Function to execute commands on remote machines via SSH
function executeRemoteCommand(ip, command, callback) {
    const conn = new Client();
    conn.on('ready', () => {
        console.log(`Connected to ${ip}`);
        conn.exec(command, (err, stream) => {
            if (err) {
                console.error(`Error executing command on ${ip}:`, err);
                callback(err, null);
                return;
            }
            let output = '';
            stream.on('data', (data) => {
                output += data;
            }).on('close', () => {
                console.log(`Executed command on ${ip}: ${command}`);
                console.log(output);
                conn.end();
                callback(null, output);
            });
        });
    }).connect({
        host: ip,
        port: 22,
        username: username,
        password: password,
    });
}

// Function to install JMeter (if not already installed)
function installJMeter(ip, callback) {
    const checkJMeterCommand = `PATH=$PATH:${jmeterDir}/bin; which jmeter || echo "not found"`;
        // Run the check locally
        executeRemoteCommand(ip, checkJMeterCommand, (err, result) => {
            if (err) {
                callback(err);
                return;
            }
            if (result && result.trim() === 'not found') {
                const downloadUrl = `https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${jmeterVersion}.tgz`;
                const installCommand = `
                    wget ${downloadUrl} -O /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                    tar -xvzf /tmp/apache-jmeter-${jmeterVersion}.tgz -C /opt && \
                    rm /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                    ln -s /opt/apache-jmeter-${jmeterVersion} /opt/jmeter
                `;
                const setPathCommand = 'echo "export PATH=$PATH:/opt/jmeter/bin" >> ~/.bashrc && source ~/.bashrc';
                
                executeRemoteCommand(ip, setPathCommand, (err) => {
                    if (err) {
                        callback(err);
                        return;
                    }
                    executeRemoteCommand(ip, installCommand, callback);
                });
            } else {
                const message = 'JMeter is already installed';
                callback(null, message);
            }
        });
}

// Function to configure and start JMeter slave
function startJMeterSlave(ip, serverPort, port, callback) {
    console.log(`Checking port ${port} availability for slave on ${ip}...`);
    checkPortAvailability(serverPort, (err) => {
        if (err) {
            console.error(`Port check failed: ${err.message}`);
            return callback(err);
        }
        console.log(`Starting slave on IP: ${ip}, Port: ${port}`);
        const slaveCommand = `cd ${jmeterDir}/bin && ./jmeter-server -Dserver_port=${serverPort} -Djava.rmi.server.hostname=${ip} -Dserver.rmi.localport=${port} -Dserver.rmi.port=${serverPort} &`;
        executeRemoteCommand(ip, slaveCommand, (err, stdout) => {
            if (err) {
                console.error(`Error starting slave on ${ip}:`, err);
                return callback(err);
            }
            console.log(`Slave started successfully on ${ip}:${port}`);
            callback(null, stdout);
        });
    });
}

function logWithTimestamp(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
}


// Function to configure the master JMeter (remote_hosts)
function configureMaster(ip, remoteHosts, callback) {
    const configFile = `${jmeterDir}/bin/jmeter.properties`;
    const remoteHostsLine = `remote_hosts=${remoteHosts.join(',')}`;
    const command = `echo "${remoteHostsLine}" >> ${configFile}`;
        executeRemoteCommand(ip, command, callback);
}

// Function to start the JMeter test on master
function startJMeterMaster(ip, callback) {
    const masterCommand = `${jmeterDir}/bin/jmeter -n -t ${testPlanPath} -l ${resultPath}`;
        executeRemoteCommand(ip, masterCommand, callback);
}

function checkPortAvailability(port, callback) {
    const findCommand = `netstat -tuln | grep ${port}`;
    const killCommand = `lsof -ti:${port} | xargs -r kill -9`;

    // Check if the port is in use
    exec(findCommand, (err, stdout) => {
        if (stdout && stdout.includes(port)) {
            console.log(`Port ${port} is in use. Attempting to free it...`);

            // Kill processes using the port
            exec(killCommand, (killErr) => {
                if (killErr) {
                    console.error(`Failed to kill processes on port ${port}:`, killErr.message);
                    callback(killErr);
                    return;
                }
                console.log(`Successfully freed port ${port}.`);
                callback(null); // Port is now available
            });
        } else {
            console.log(`Port ${port} is available.`);
            callback(null); // Port is available
        }
    });
}


// Main Execution Flow
async function run() {
    try {
        console.log('Checking JMeter installation...');
        await new Promise((resolve, reject) => {
            installJMeter('localhost', (err, result) => {
                if (err) return reject(err);
                console.log(result || 'JMeter installation check complete.');
                resolve();
            });
        });

        console.log('Starting JMeter slaves...');
        const slavePorts = [4001, 4002];
        const serverPorts = [1099, 1100];
        for (let index = 0; index < slaveIps.length; index++) {
            const slavePort = slavePorts[index];
            const serverPort = serverPorts[index];
            console.log(`Processing slave ${index + 1} of ${slaveIps.length}`);
            await new Promise((resolve, reject) => {
                startJMeterSlave(slaveIps[index], serverPort, slavePort, (err) => {
                    if (err) return reject(err);
                    console.log(`Slave started on ${slaveIps[index]}:${slavePort}`);
                    resolve();
                });
            });
        }

        console.log('Configuring master with slave IPs...');
        const remoteHosts = slaveIps.map((ip, index) => `${ip}:${slavePorts[index]}`);
        await new Promise((resolve, reject) => {
            configureMaster(masterIp, remoteHosts, (err) => {
                if (err) return reject(err);
                console.log('Master configured with remote hosts:', remoteHosts.join(', '));
                resolve();
            });
        });

        console.log('Starting the test on master...');
        await new Promise((resolve, reject) => {
            startJMeterMaster(masterIp, (err) => {
                if (err) return reject(err);
                console.log('Test started on master');
                resolve();
            });
        });

        console.log('Execution flow completed successfully!');
    } catch (error) {
        console.error('Error during execution:', error);
    }
}

run();