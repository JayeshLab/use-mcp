<script setup lang="ts">
import { ref } from 'vue';
import { useMcp } from 'use-mcp/vue';

const serverUrl = ref('http://localhost:5101');
const mcp = ref<any>(null);

const connect = () => {
  mcp.value = useMcp({
    url: serverUrl.value,
    debug: true,
  });
};

const disconnect = () => {
  mcp.value.disconnect();
  mcp.value = null;
};
</script>

<template>
  <div>
    <h1>Vue MCP Chat UI Example</h1>
    <div>
      <input v-model="serverUrl" type="text" placeholder="Enter server URL" />
      <button v-if="!mcp" @click="connect">Connect</button>
      <button v-if="mcp" @click="disconnect">Disconnect</button>
    </div>

    <div v-if="mcp">
      <h2>Connection State: {{ mcp.state.value }}</h2>

      <div v-if="mcp.error.value">
        <h3>Error</h3>
        <pre>{{ mcp.error.value }}</pre>
      </div>

      <h3>Tools</h3>
      <ul>
        <li v-for="tool in mcp.tools.value" :key="tool.name">
          {{ tool.name }}
        </li>
      </ul>

      <h3>Logs</h3>
      <pre>
        <div v-for="(log, index) in mcp.log.value" :key="index">
          {{ new Date(log.timestamp).toLocaleTimeString() }} [{{ log.level }}] {{ log.message }}
        </div>
      </pre>
    </div>
  </div>
</template>

<style scoped>
/* Add some basic styling */
body {
  font-family: sans-serif;
}
input {
  margin-right: 10px;
}
pre {
  background-color: #f4f4f4;
  padding: 10px;
  border-radius: 5px;
  max-height: 300px;
  overflow-y: auto;
}
</style>
