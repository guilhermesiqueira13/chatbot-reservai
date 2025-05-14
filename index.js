const express = require("express");
const twilio = require("twilio");
const sqlite3 = require("sqlite3").verbose();
const dotenv = require("dotenv");
const schedule = require("node-schedule");

// Carrega variáveis de ambiente
dotenv.config();

// Configuração do Twilio
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);

// Configuração do Express
const app = express();
app.use(express.urlencoded({ extended: true }));

// Configuração do banco de dados SQLite
const db = new sqlite3.Database("barbershop.db"); // Persistência em arquivo

// Função para obter a data de amanhã formatada
function getTomorrowDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split("T")[0];
}

// Inicializa o banco de dados
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    UNIQUE (date, time)
  )`);

  // Insere horários disponíveis (exemplo: 10h, 11h, 14h, 15h para amanhã)
  const tomorrowDate = getTomorrowDate();
  const availableTimes = ["10:00", "11:00", "14:00", "15:00"];
  availableTimes.forEach((time) => {
    db.run(`INSERT OR IGNORE INTO appointments (date, time) VALUES (?, ?)`, [
      tomorrowDate,
      time,
    ]);
  });
});

// Função para listar horários disponíveis
function getAvailableTimes(date, callback) {
  db.all(
    `SELECT time FROM appointments WHERE date = ? AND phone IS NULL`,
    [date],
    (err, rows) => {
      if (err) {
        console.error(err);
        callback([]);
      } else {
        callback(rows.map((row) => row.time));
      }
    }
  );
}

// Função para verificar agendamento existente
function getUserAppointment(phone, callback) {
  db.get(
    `SELECT date, time FROM appointments WHERE phone = ?`,
    [phone],
    (err, row) => {
      if (err) {
        console.error(err);
        callback(null);
      } else {
        callback(row);
      }
    }
  );
}

// Função para agendar
function bookAppointment(phone, date, time, callback) {
  db.run(
    `UPDATE appointments SET phone = ? WHERE date = ? AND time = ? AND phone IS NULL`,
    [phone, date, time],
    function (err) {
      if (err || this.changes === 0) {
        callback(false);
      } else {
        callback(true);
      }
    }
  );
}

// Função para reagendar
function rescheduleAppointment(phone, newTime, callback) {
  getUserAppointment(phone, (appointment) => {
    if (!appointment) {
      callback(false, "Nenhum agendamento encontrado.");
      return;
    }
    const tomorrowDate = getTomorrowDate();
    db.run(
      `UPDATE appointments SET phone = NULL WHERE phone = ?`,
      [phone],
      (err) => {
        if (err) {
          callback(false, "Erro ao liberar horário antigo.");
          return;
        }
        db.run(
          `UPDATE appointments SET phone = ? WHERE date = ? AND time = ? AND phone IS NULL`,
          [phone, tomorrowDate, newTime],
          function (err) {
            if (err || this.changes === 0) {
              callback(false, "Horário não disponível.");
            } else {
              callback(true, "Reagendamento concluído!");
            }
          }
        );
      }
    );
  });
}

// Webhook para processar mensagens recebidas
app.post("/sms", (req, res) => {
  const userMessage = req.body.Body.trim().toLowerCase();
  const userPhone = req.body.From;
  const tomorrowDate = getTomorrowDate();

  const twiml = new twilio.twiml.MessagingResponse();

  if (userMessage === "agendar") {
    getAvailableTimes(tomorrowDate, (times) => {
      if (times.length === 0) {
        twiml.message("Nenhum horário disponível no momento.");
      } else {
        twiml.message(
          `Horários disponíveis para amanhã: ${times.join(
            ", "
          )}. Responda com o horário desejado (ex.: 10:00).`
        );
      }
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml.toString());
    });
  } else if (userMessage === "reagendar") {
    getUserAppointment(userPhone, (appointment) => {
      if (!appointment) {
        twiml.message(
          'Você não tem nenhum agendamento. Deseja agendar? Responda "agendar".'
        );
      } else {
        getAvailableTimes(tomorrowDate, (times) => {
          if (times.length === 0) {
            twiml.message("Nenhum horário disponível para reagendar.");
          } else {
            twiml.message(
              `Seu agendamento atual: ${
                appointment.time
              }. Horários disponíveis: ${times.join(
                ", "
              )}. Responda com o novo horário.`
            );
          }
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml.toString());
        });
      }
    });
  } else if (userMessage.match(/^\d{2}:\d{2}$/)) {
    // Usuário enviou um horário
    getUserAppointment(userPhone, (appointment) => {
      if (appointment) {
        // Usuário está tentando reagendar
        rescheduleAppointment(userPhone, userMessage, (success, message) => {
          twiml.message(success ? message : `Erro: ${message}`);
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml.toString());
        });
      } else {
        // Usuário está agendando
        bookAppointment(userPhone, tomorrowDate, userMessage, (success) => {
          twiml.message(
            success
              ? `Agendamento confirmado para amanhã às ${userMessage}!`
              : "Horário indisponível. Tente outro."
          );
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml.toString());
        });
      }
    });
  } else {
    twiml.message(
      'Comandos: "agendar" para marcar um horário, "reagendar" para alterar um agendamento.'
    );
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());
  }
});

// Inicia o servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
