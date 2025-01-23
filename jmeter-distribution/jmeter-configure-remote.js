require('dotenv').config(); // Load .env file
const { exec } = require('child_process');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

// Configuration Details from .env file
const masterIp = process.env.MASTER_IP;
const slaveIps = process.env.SLAVE_IPS.split(',');
const jmeterDir = process.env.JMETER_DIR;
const threadDistribution = process.env.THREAD_DISTRIBUTION.split(',').map(num => parseInt(num));
const jmeterVersion = process.env.JMETER_VERSION;
const testPlanPath = process.env.TEST_PLAN_PATH; // Absolute path to .jmx file
const resultPath = process.env.RESULT_PATH; // Absolute path to result .jtl file
const username = process.env.SSH_USERNAME;  // Loaded from environment variables
const password = process.env.SSH_PASSWORD; 

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

// Function to check and install JMeter on a remote machine
function installJMeter(ip, callback) {
    const checkJMeterCommand = `PATH=$PATH:${jmeterDir}/bin; which jmeter || echo "not found"`;
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
            executeRemoteCommand(ip, `${installCommand} && ${setPathCommand}`, callback);
        } else {
            const message = `JMeter is already installed on ${ip}`;
            callback(null, message);
        }
    });
}

// Function to configure the master to instruct slaves
function configureMaster(ip, remoteHosts, callback) {
    const configFile = `${jmeterDir}/bin/jmeter.properties`;
    const remoteHostsLine = `remote_hosts=${remoteHosts.join(',')}`;
    const command = `echo "${remoteHostsLine}" >> ${configFile}`;
    executeRemoteCommand(ip, command, callback);
}

// Function to start tests on all slaves from the master
function startTestsOnSlaves(masterIp, callback) {
    const masterCommand = `${jmeterDir}/bin/jmeter -n -r -t ${testPlanPath} -l ${resultPath}`;
    executeRemoteCommand(masterIp, masterCommand, callback);
}

// Main Execution Flow
async function run() {
    try {
        console.log('Checking JMeter installation on master and slaves...');
        await new Promise((resolve, reject) => {
            installJMeter(masterIp, (err, result) => {
                if (err) return reject(err);
                console.log(result || 'Master JMeter installation check complete.');
                resolve();
            });
        });

        for (const slaveIp of slaveIps) {
            await new Promise((resolve, reject) => {
                installJMeter(slaveIp, (err, result) => {
                    if (err) return reject(err);
                    console.log(result || `Slave ${slaveIp} JMeter installation check complete.`);
                    resolve();
                });
            });
        }

        console.log('Configuring master with slave IPs...');
        await new Promise((resolve, reject) => {
            configureMaster(masterIp, slaveIps, (err) => {
                if (err) return reject(err);
                console.log('Master configured with slave IPs:', slaveIps.join(', '));
                resolve();
            });
        });

        console.log('Starting tests on slaves...');
        await new Promise((resolve, reject) => {
            startTestsOnSlaves(masterIp, (err) => {
                if (err) return reject(err);
                console.log('Tests started successfully on slaves.');
                resolve();
            });
        });

        console.log('Execution completed successfully!');
    } catch (error) {
        console.error('Error during execution:', error);
    }
}

run();
