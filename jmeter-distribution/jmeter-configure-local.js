require('dotenv').config(); // Load .env file
const { exec } = require('child_process');

// Configuration Details from .env file
const { JMETER_DIR: jmeterDir, TEST_PLAN_PATH: testPlanPath, RESULT_PATH: resultPath, JMETER_VERSION: jmeterVersion } = process.env;

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
function installJMeter(callback) {
    const checkJMeterCommand = `PATH=$PATH:${jmeterDir}/bin; which jmeter || echo "not found"`;
    executeLocalCommand(checkJMeterCommand, (err, result) => {
        if (err) return callback(err);

        if (result && result.trim() === 'not found') {
            const downloadUrl = `https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${jmeterVersion}.tgz`;
            const installCommand = `
                wget ${downloadUrl} -O /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                tar -xvzf /tmp/apache-jmeter-${jmeterVersion}.tgz -C /opt && \
                rm /tmp/apache-jmeter-${jmeterVersion}.tgz && \
                ln -s /opt/apache-jmeter-${jmeterVersion} /opt/jmeter
            `;
            executeLocalCommand(installCommand, callback);
        } else {
            callback(null, 'JMeter is already installed');
        }
    });
}

// Function to start JMeter slave locally
function startJMeterSlave(serverPort, port, callback) {
    const slaveCommand = `cd ${jmeterDir}/bin && ./jmeter-server -Dserver_port=${serverPort}`;
    executeLocalCommand(slaveCommand, callback);
}

// Function to start JMeter master locally
function startJMeterMaster(callback) {
    const masterCommand = `${jmeterDir}/bin/jmeter -n -t ${testPlanPath} -l ${resultPath}`;
    executeLocalCommand(masterCommand, callback);
}

// Main Execution Flow for Local
function runLocal() {
    console.log('Installing JMeter locally...');
    installJMeter(() => {
        console.log('Starting JMeter slave locally...');
        startJMeterSlave(1099, 1099, () => {
            console.log('Starting the test locally...');
            startJMeterMaster(() => {
                console.log('Test execution completed locally.');
            });
        });
    });
}

runLocal();
