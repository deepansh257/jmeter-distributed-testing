require('dotenv').config(); // Load .env file
const { Client } = require('ssh2');
const { exec } = require('child_process');
const { resolve } = require('path');
const { rejects } = require('assert');
const { spawn } = require('child_process');

// Configuration Details from .env file
const masterIp = process.env.MASTER_IP;
const slaveIps = process.env.SLAVE_IPS.split(',');
const jmeterDir = process.env.JMETER_DIR || '/opt/jmeter';
const jmeterVersion = process.env.JMETER_VERSION;
const testPlanPath = process.env.TEST_PLAN_PATH; // Absolute path to .jmx file
const resultPath = process.env.RESULT_PATH; // Absolute path to result .jtl file
const username = process.env.SSH_USERNAME;
const password = process.env.SSH_PASSWORD;

function executeCommand(ip, command, callback) {
    const conn = new Client();
    conn.on('ready', () => {
        console.log(`Connected to ${ip}`);
        // Explicitly set the PATH for non-interactive sessions
        const pathCommand = 'export PATH=$PATH:/opt/jmeter/bin; ' + command;
        conn.exec(pathCommand, (err, stream) => {
            if (err) {
                console.error(`Error executing command on ${ip}:`, err);
                callback(err, null);
                return;
            }
            let output = '';
            let errorOutput = '';
            stream.on('data', (data) => {
                output += data;
            }).on('stderr', (data) => {
                errorOutput += data;
            }).on('close', () => {
                console.log(`Executed command on ${ip}: ${command}`);
                if (errorOutput) {
                    console.error(`Error on ${ip}: ${errorOutput}`);
                }
                console.log(output);
                conn.end();
                callback(null, output.trim());
            });
        });
    }).connect({
        host: ip,
        port: 22,
        username: username,
        password: password,
    });
}

function executeBackgroundCommand(ip, command, callback) {
    const conn = new Client();

    conn.on('ready', () => {
        console.log(`Connected to ${ip}`);

        // Run the command on the remote server in the background
        const pathCommand = 'export PATH=$PATH:/opt/jmeter/bin; ' + command;
        conn.exec(pathCommand, (err, stream) => {
            if (err) {
                console.error(`Error executing command on ${ip}:`, err);
                conn.end(); // Explicitly close the connection
                callback(err, null);
                return;
            }

            // Don't wait for the command to finish; close SSH immediately
            stream.on('close', () => {
                console.log(`Command sent to ${ip}. Closing SSH connection.`);
            });

            console.log(`Command sent to ${ip}. Waiting for 5 seconds before closing SSH connection.`);
            setTimeout(() => {
                conn.end(); // Close the SSH connection after the delay
                console.log(`SSH connection to ${ip} closed.`);
                callback(null, 'Background process started after delay.');
            }, 5000); // 5-second delay

            // Explicitly ignore data from the stream to prevent blocking
            stream.on('data', () => {});
            stream.stderr.on('data', () => {});
        });
    }).connect({
        host: ip,
        port: 22,
        username: 'root',
        password: password,
    });
}

function tailRemoteLog(ip, logFilePath, callback) {
    const conn = new Client();
    conn.on('ready', () => {
        console.log(`Connected to ${ip}. Tailing log file: ${logFilePath}`);

        // Execute the tail command to stream the log file
        const tailCommand = `tail -f ${logFilePath}`;
        conn.exec(tailCommand, (err, stream) => {
            if (err) {
                console.error(`Error executing command on ${ip}:`, err);
                conn.end();
                callback(err, null);
                return;
            }

            stream.on('data', (data) => {
                console.log(`[${ip}] ${data.toString()}`);
            });

            stream.stderr.on('data', (data) => {
                console.error(`[${ip}] ERROR: ${data.toString()}`);
            });

            // Do not close the connection, as tail -f runs indefinitely
            stream.on('close', () => {
                console.log(`Stopped tailing log file on ${ip}`);
                conn.end();
                callback(null, 'Log monitoring ended.');
            });
        });
    }).connect({
        host: ip,
        port: 22,
        username: username,
        password: password,
    });
}

// Function to check JMeter installation
function checkJMeter(ip, callback) {
    const checkCommand = `which jmeter || echo "not found"`;
    executeCommand(ip, checkCommand, (err, result) => {
        if (err) {
            callback(err);
            return;
        }
        if (result === 'not found') {
            callback(null, false); // JMeter is not installed
        } else {
            callback(null, true); // JMeter is installed
        }
    });
}

// Function to check if Java is installed
function checkJava(ip, callback) {
    const checkCommand = `java -version 2>&1 || echo "not found"`;
    executeCommand(ip, checkCommand, (err, result) => {
        if (err) {
            callback(err);
            return;
        }
        if (result.includes('not found')) {
            callback(null, false); // Java is not installed
        } else {
            callback(null, true); // Java is installed
        }
    });
}

// Function to install Java
function installJava(ip, callback) {
    const installCommand = `
        apt-get update && \
        apt-get install -y openjdk-11-jdk && \
        echo "JAVA_HOME=/usr/lib/jvm/java-11-openjdk-amd64" >> ~/.bashrc && \
        echo "JRE_HOME=\$JAVA_HOME" >> ~/.bashrc && \
        source ~/.bashrc && \
        echo "Java installed successfully"
    `;
    executeCommand(ip, installCommand, callback);
}

// Function to install JMeter
function installJMeter(ip, callback) {
    // const installCommand = `
    //     wget https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${jmeterVersion}.tgz -O /tmp/apache-jmeter-${jmeterVersion}.tgz && \
    //     tar -xvzf /tmp/apache-jmeter-${jmeterVersion}.tgz -C /opt && \
    //     rm /tmp/apache-jmeter-${jmeterVersion}.tgz && \
    //     ln -s /opt/apache-jmeter-${jmeterVersion} /opt/jmeter
    //     echo "export PATH=$PATH:/opt/jmeter/bin" >> ~/.bashrc && \
    //     source ~/.bashrc
    // `;
    const installCommand = `
    wget https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${jmeterVersion}.tgz -O /tmp/apache-jmeter-${jmeterVersion}.tgz && \
    echo "Downloaded JMeter" && \
    tar -xvzf /tmp/apache-jmeter-${jmeterVersion}.tgz -C /opt && \
    echo "Extracted JMeter" && \
    rm /tmp/apache-jmeter-${jmeterVersion}.tgz && \
    ln -s /opt/apache-jmeter-${jmeterVersion} /opt/jmeter && \
    echo "JMeter installation complete"
`;

    executeCommand(ip, installCommand, callback);
}

// Function to configure master for remote execution
function configureMaster(ip, remoteHosts, callback) {
    const configFile = `${jmeterDir}/bin/jmeter.properties`;
    const remoteHostsLine = `remote_hosts=${remoteHosts.join(',')}`;
    const command = `echo "${remoteHostsLine}" >> ${configFile}`;
    executeCommand(ip, command, callback);
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

// Function to configure and start JMeter slave
function startJMeterSlave(ip, serverPort, port, callback) {
    console.log(`Checking port ${serverPort} availability for slave on ${ip}...`);
    checkPortAvailability(serverPort, (err) => {
        if (err) {
            console.error(`Port check failed: ${err.message}`);
            return callback(err);
        }
        console.log(`Starting slave on IP: ${ip}, Port: ${port}`);
        const slaveCommand = `cd ${jmeterDir}/bin && \
        nohup ./jmeter-server -Dserver_port=${serverPort} -Djava.rmi.server.hostname=${ip} -Dserver.rmi.localport=${port} -Dserver.rmi.port=${serverPort} > /opt/jmeter/bin/jmeter-server.log 2>&1 & disown & sleep 5`;
        executeBackgroundCommand(ip, slaveCommand, (err, stdout) => {
            if (err) {
                console.error(`Error starting slave on ${ip}:`, err);
                return callback(err);
            }
            console.log(`Slave started successfully on ${ip}:${port}`);
            callback(null, stdout);
        });
    });
}

async function waitForSlaveReady(ip, port, callback) {
    const checkCommand = `lsof -i :${port}`;
    executeCommand(ip, checkCommand, (err, result) => {
        if (err) {
            return callback(err);
        }
        if (result) {
            callback(null, true); // Port is available and the slave is ready
        } else {
            console.log(`Waiting for port ${port} on ${ip}...`);
            setTimeout(() => waitForSlaveReady(ip, port, callback), 5000); // Retry every 5 seconds
        }
    });
}


//Function to run tests on slaves via master
function runTestsOnSlaves(ip, callback) {
    const command = `${jmeterDir}/bin/jmeter -n -r -t ${testPlanPath} -l ${resultPath}`;
    executeCommand(ip, command, callback);
}

async function runTestsAndMonitorLogs(masterIp, slaveIp, logFilePath) {
    console.log('Running tests on slaves via master...');
    const runTestPromise = new Promise((resolve, reject) => {
        runTestsOnSlaves(masterIp, (err) => {
            if (err) return reject(err);
            console.log('Tests started on slaves via master.');
            resolve();
        });
    });

    const monitorLogsPromise = new Promise((resolve, reject) => {
        tailRemoteLog(slaveIp, logFilePath, (err) => {
            if (err) return reject(err);
            resolve();
        });
    });

    await Promise.all([runTestPromise, monitorLogsPromise]);
}



// Function to copy rmi_keystore.jks to remote hosts
function copyRmiKeystore(ip, callback) {
    const copyCommand = `scp -o StrictHostKeyChecking=no /opt/jmeter/bin/rmi_keystore.jks ${username}@${ip}:/opt/jmeter/bin/`;
    executeCommand(masterIp, copyCommand, (err, result) => {
        if (err) {
            console.error(`Error copying keystore to ${ip}:`, err);
            return callback(err);
        }
        console.log(`Keystore copied successfully to ${ip}`);
        callback(null, result);
    });
}

// Function to update jmeter.properties on master and slave
function updateJMeterProperties(ip, callback) {
    // const updateCommand = `
    //     echo "server.rmi.ssl.keystore.file=/opt/jmeter/bin/rmi_keystore.jks" >> /opt/jmeter/bin/jmeter.properties && \
    //     echo "server.rmi.ssl.keystore.password=changeit" >> /opt/jmeter/bin/jmeter.properties && \
    //     echo "server.rmi.ssl.truststore.file=/opt/jmeter/bin/rmi_keystore.jks" >> /opt/jmeter/bin/jmeter.properties && \
    //     echo "server.rmi.ssl.truststore.password=changeit" >> /opt/jmeter/bin/jmeter.properties && \
    //     echo "java.rmi.server.hostname=${ip}" >> /opt/jmeter/bin/jmeter.properties
    // `;
    const updateCommand = `
    echo "server.rmi.ssl.disable=true" >> /opt/jmeter/bin/jmeter.properties && \
    echo "java.rmi.server.hostname=${ip}" >> /opt/jmeter/bin/jmeter.properties
`;
    executeCommand(ip, updateCommand, callback);
}

// Function to generate rmi_keystore.jks
function generateRmiKeystore(ip, callback) {
    const deleteCommand = `
        keytool -delete -alias rmi -keystore /opt/jmeter/bin/rmi_keystore.jks -storepass changeit || echo "Alias 'rmi' does not exist, skipping delete.";
    `;
    const generateCommand = `
        ${deleteCommand}
        keytool -genkeypair -alias rmi -keyalg RSA -keystore /opt/jmeter/bin/rmi_keystore.jks -validity 3650 \
        -storepass changeit -keypass changeit -dname "CN=${ip}, OU=JMeter, O=Apache, L=Test, S=State, C=US" && \
        echo "Keystore created successfully on ${ip}";
    `;

    executeCommand(ip, generateCommand, callback);
}

function exportSlaveCertAndImportToMaster(ip, callback) {
    // Command to export the slave certificate from the slave's keystore
    const exportCertCommand = `
        keytool -export -alias rmi -keystore /opt/jmeter/bin/rmi_keystore.jks -file /opt/jmeter/bin/slave_cert.cer -storepass changeit
    `;
    executeCommand(ip, exportCertCommand, (err, result) => {
        if (err) {
            return callback(err);
        }

        console.log(`Certificate exported from slave: ${ip}`);

        // Command to copy the exported certificate to the master
        const copyCertToMasterCommand = `scp -o StrictHostKeyChecking=no /opt/jmeter/bin/slave_cert.cer ${username}@${masterIp}:/opt/jmeter/bin/`;
        executeCommand(ip, copyCertToMasterCommand, (err) => {
            if (err) {
                return callback(err);
            }
            console.log('Slave certificate copied to master.');

            // Command to import the slave's certificate into the master’s truststore
            const importCertCommand = `
                keytool -import -trustcacerts -file /opt/jmeter/bin/slave_cert.cer -alias slave -keystore /opt/jmeter/bin/rmi_truststore.jks -storepass changeit -noprompt
            `;
            executeCommand(masterIp, importCertCommand, (err) => {
                if (err) {
                    return callback(err);
                }
                console.log('Slave certificate successfully imported into master truststore.');
                callback(null, 'Certificate import process completed.');
            });
        });
    });
}

// Main Execution Flow
async function run() {
    try {
        console.log('Checking Java installation on master...');
        const masterJavaInstalled = await new Promise((resolve, reject) => {
            checkJava(masterIp, (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });
        if (!masterJavaInstalled) {
            console.log('Installing Java on master...');
            await new Promise((resolve, reject) => {
                installJava(masterIp, (err) => {
                    if (err) return reject(err);
                    console.log('Java installed on master.');
                    resolve();
                });
            });
        } else {
            console.log('Java is already installed on master.');
        }

        console.log('Checking JMeter installation on master...');
        const masterInstalled = await new Promise((resolve, reject) => {
            checkJMeter(masterIp, (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });

        if (!masterInstalled) {
            console.log('Installing JMeter on master...');
            await new Promise((resolve, reject) => {
                installJMeter(masterIp, (err) => {
                    if (err) return reject(err);
                    console.log('JMeter installed on master.');
                    resolve();
                });
            });
        } else {
            console.log('JMeter is already installed on master.');
        }

        console.log('Checking Java installation on slaves...');
        for (const slaveIp of slaveIps) {
            const slaveJavaInstalled = await new Promise((resolve, reject) => {
                checkJava(slaveIp, (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });

            if (!slaveJavaInstalled) {
                console.log(`Installing Java on slave: ${slaveIp}...`);
                await new Promise((resolve, reject) => {
                    installJava(slaveIp, (err) => {
                        if (err) return reject(err);
                        console.log(`Java installed on slave: ${slaveIp}.`);
                        resolve();
                    });
                });
            } else {
                console.log(`Java is already installed on slave: ${slaveIp}.`);
            }
        }

        console.log('Checking JMeter installation on slaves...');
        for (const slaveIp of slaveIps) {
            const installed = await new Promise((resolve, reject) => {
                checkJMeter(slaveIp, (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });

            if (!installed) {
                console.log(`Installing JMeter on slave: ${slaveIp}...`);
                await new Promise((resolve, reject) => {
                    installJMeter(slaveIp, (err) => {
                        if (err) return reject(err);
                        console.log(`JMeter installed on slave: ${slaveIp}.`);
                        resolve();
                    });
                });
            } else {
                console.log(`JMeter is already installed on slave: ${slaveIp}.`);
            }
        }

        console.log('Configuring master with slave IPs...');
        await new Promise((resolve, reject) => {
            configureMaster(masterIp, slaveIps, (err) => {
                if (err) return reject(err);
                console.log('Master configured with slave IPs.');
                resolve();
            });
        });

    //     console.log('Generating rmi_keystore.jks on master...');
    //     await new Promise((resolve, reject) => {
    //         generateRmiKeystore(masterIp, (err) => {
    //             if (err) return reject(err);
    //             console.log('Keystore created on master.');
    //             resolve();
    //         });
    //     });

    //     //Generate rmi_keystore.jks on each slave
    // for (const slaveIp of slaveIps) {
    // console.log(`Generating keystore on slave: ${slaveIp}...`);
    // await new Promise((resolve, reject) => {
    //     generateRmiKeystore(slaveIp, (err) => {
    //         if (err) return reject(err);
    //         console.log(`Keystore generated on slave: ${slaveIp}.`);
    //         resolve();
    //     });
    // });
    // }

        // Update jmeter.properties on master and slaves
        console.log('Updating jmeter.properties on master...');
        await new Promise((resolve, reject) => {
            updateJMeterProperties(masterIp, (err) => {
                if (err) return reject(err);
                console.log('jmeter.properties updated on master.');
                resolve();
            });
        });

        for (const slaveIp of slaveIps) {
            console.log(`Updating jmeter.properties on slave: ${slaveIp}...`);
            await new Promise((resolve, reject) => {
                updateJMeterProperties(slaveIp, (err) => {
                    if (err) return reject(err);
                    console.log(`jmeter.properties updated on slave: ${slaveIp}.`);
                    resolve();
                });
            });
        }

        console.log('Starting JMeter slaves...');
        const slavePorts = [4001];
        const serverPorts = [1099];
        for (let index = 0; index < slaveIps.length; index++) {
            console.log("slavePorts[index] : ", slaveIps[index])
            const slavePort = slavePorts[index];
            const serverPort = serverPorts[index];
            console.log(`Processing slave ${index + 1} of ${slaveIps.length}`);
            await new Promise((resolve, reject) => {
                startJMeterSlave(slaveIps[index], serverPort, slavePort, (err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        }

        console.log('Running tests on slaves via master...');
        await new Promise((resolve, reject) => {
            runTestsOnSlaves(masterIp, (err) => {
                if (err) return reject(err);
                console.log('Tests started on slaves via master.');
                resolve();
            });
        });

        console.log('Execution completed successfully!');
    } catch (error) {
        console.error('Error during execution:', error);
    }
}

run();
