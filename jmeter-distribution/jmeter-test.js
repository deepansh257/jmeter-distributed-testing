require('dotenv').config(); // Load .env file
const { exec } = require('child_process');
const { Client } = require('ssh2');

// Configuration Details from .env file
const runMode = process.env.RUN_MODE; // 'local' or 'remote'
const masterIp = process.env.MASTER_IP;
const slaveIps = process.env.SLAVE_IPS.split(',');
const jmeterDir = process.env.JMETER_DIR;
const serverPort = parseInt(process.env.SERVER_PORT);
const threadDistribution = process.env.THREAD_DISTRIBUTION.split(',').map(num => parseInt(num));
const username = process.env.USERNAME;
const password = process.env.PASSWORD;
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

// Function to execute commands locally
function executeLocalCommand(command, callback) {
    exec(command, (err, stdout, stderr) => {
        if (err) {
            console.error(`Error executing command: ${err}`);
            callback(err, null);
            return;
        }
        console.log(`Command output: ${stdout}`);
        callback(null, stdout);
    });
}

// Function to install JMeter (if not already installed)
function installJMeter(ip, callback) {
    const checkJMeterCommand = `PATH=$PATH:${jmeterDir}/bin; which jmeter || echo "not found"`;
    if (runMode === 'local') {
        // Run the check locally
        executeLocalCommand(checkJMeterCommand, (err, result) => {
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
                
                executeLocalCommand(setPathCommand, (err) => {
                    if (err) {
                        callback(err);
                        return;
                    }
                    executeLocalCommand(installCommand, callback);
                });
            } else {
                callback(null, 'JMeter is already installed');
            }
        });
    } else {
        // Execute the check on remote machine
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
                callback(null, 'JMeter is already installed');
            }
        });
    }
}

// Function to configure and start JMeter slave
function startJMeterSlave(ip, serverPort, port, callback) {
    const slaveCommand = `cd ${jmeterDir}/bin && ./jmeter-server -Dserver_port=${serverPort} -Djava.rmi.server.hostname=${ip} -Dserver.rmi.localport=${port} -Dserver.rmi.port=${serverPort}`;
    if (runMode === 'local') {
        executeLocalCommand(slaveCommand, callback);
    } else {
        executeRemoteCommand(ip, slaveCommand, callback);
    }
}

// Function to configure the master JMeter (remote_hosts)
function configureMaster(ip, remoteHosts, callback) {
    const configFile = `${jmeterDir}/bin/jmeter.properties`;
    const remoteHostsLine = `remote_hosts=${remoteHosts.join(',')}`;
    const command = `echo "${remoteHostsLine}" >> ${configFile}`;
    if (runMode === 'local') {
        executeLocalCommand(command, callback);
    } else {
        executeRemoteCommand(ip, command, callback);
    }
}

// Function to start the JMeter test on master
function startJMeterMaster(ip, callback) {
    const masterCommand = `${jmeterDir}/bin/jmeter -n -t ${testPlanPath} -l ${resultPath}`;
    if (runMode === 'local') {
        executeLocalCommand(masterCommand, callback);
    } else {
        executeRemoteCommand(ip, masterCommand, callback);
    }
}

// Main Execution Flow
function run() {
    console.log('Installing JMeter on all machines...');
    if (runMode === 'local') {
        installJMeter('localhost', () => {});
    } else {
        installJMeter(masterIp, () => {
            slaveIps.forEach((slaveIp) => {
                installJMeter(slaveIp, () => {});
            });
        });
    }

    console.log('Starting JMeter slaves...');
    const slavePorts = [4001, 4002];
    slaveIps.forEach((slaveIp, index) => {
        startJMeterSlave(slaveIp, serverPort, slavePorts[index], () => {});
    });

    console.log('Configuring master with slave IPs...');
    const remoteHosts = slaveIps.map((ip, index) => `${ip}:${slavePorts[index]}`);
    configureMaster(masterIp, remoteHosts, () => {});

    console.log('Starting the test on master...');
    startJMeterMaster(masterIp, () => {});
}

run();
