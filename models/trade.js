// models/trades.js
import { DataTypes } from 'sequelize';
import sequelize from '../config/db_config';

const Trade = sequelize.define(
  'Trade',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    token_name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    token_address: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    amount: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    buy_price: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    buy_time: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    order_id: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'open',
    },
    sell_price: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    sell_time: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    sell_order_id: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    profit_loss: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
  },
  {
    tableName: 'trades',
    timestamps: false, // Disable createdAt/updatedAt
  }
);

export default Trade;