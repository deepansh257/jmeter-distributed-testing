require('dotenv').config(); // Load .env file
const { Client } = require('ssh2');

// Configuration Details from .env file
const {
    MASTER_IP: masterIp,
    SLAVE_IPS: slaveIpsString,
    JMETER_DIR: jmeterDir,
    USERNAME: username,
    PASSWORD: password,
    JMETER_VERSION: jmeterVersion,
    TEST_PLAN_PATH: testPlanPath,
    RESULT_PATH: resultPath,
} = process.env;

const slaveIps = slaveIpsString.split(',');

// Function to execute commands on remote machines via SSH
function executeRemoteCommand(ip, command, callback) {
    const conn = new Client();
    conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
            if (err) {
                console.error(`Error executing command on ${ip}:`, err);
                callback(err, null);
                return;
            }
            let output = '';
            stream.on('data', (data) => (output += data)).on('close', () => {
                conn.end();
                callback(null, output);
            });
        });
    }).connect({ host: ip, port: 22, username, password });
}

// Function to install JMeter remotely
function installJMeter(ip, callback) {
    const checkJMeterCommand = `PATH=$PATH:${jmeterDir}/bin; which jmeter || echo "not found"`;
    executeRemoteCommand(ip, checkJMeterCommand, (err, result) => {
        if (err) return callback(err);

        if (result && result.trim() === 'not found') {
            const downloadUrl = `https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${jmeterVersion}.tgz`;
            const installCommand = `
                wget ${downloadUrl} -O /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                tar -xvzf /tmp/apache-jmeter-${jmeterVersion}.tgz -C /opt && \
                rm /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                ln -s /opt/apache-jmeter-${jmeterVersion} /opt/jmeter
            `;
            executeRemoteCommand(ip, installCommand, callback);
        } else {
            callback(null, 'JMeter is already installed');
        }
    });
}

// Function to start JMeter slave remotely
function startJMeterSlave(ip, serverPort, port, callback) {
    const slaveCommand = `cd ${jmeterDir}/bin && ./jmeter-server -Dserver_port=${serverPort}`;
    executeRemoteCommand(ip, slaveCommand, callback);
}

// Function to start JMeter master remotely
function startJMeterMaster(ip, callback) {
    const masterCommand = `${jmeterDir}/bin/jmeter -n -t ${testPlanPath} -l ${resultPath}`;
    executeRemoteCommand(ip, masterCommand, callback);
}

// Main Execution Flow for Remote
function runRemote() {
    console.log('Installing JMeter on master and slaves...');
    installJMeter(masterIp, () => {
        slaveIps.forEach((slaveIp) => {
            installJMeter(slaveIp, () => {
                console.log(`JMeter installed on ${slaveIp}`);
            });
        });
        console.log('Starting JMeter slaves...');
        slaveIps.forEach((slaveIp, index) => {
            startJMeterSlave(slaveIp, 1099 + index, 1099 + index, () => {
                console.log(`JMeter slave started on ${slaveIp}`);
            });
        });
        console.log('Starting the test on master...');
        startJMeterMaster(masterIp, () => {
            console.log('Test execution completed remotely.');
        });
    });
}

runRemote();
